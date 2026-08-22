/**
 * Express router: /api/cards/*
 *
 *   POST   /generate          compose a card from multipart fields + photo upload
 *   GET    /layout            effective coordinate map (defaults + custom overrides)
 *   PUT    /layout            save a custom coordinate map (admin)
 *   DELETE /layout            reset the custom coordinate map to defaults (admin)
 *   POST   /template          upload the organization's own template image (admin)
 *   DELETE /template          remove the custom template + layout (admin)
 *   GET    /template-preview  the currently active template PNG
 *   GET    /:id/preview       inline PNG preview of a generated card
 *   GET    /:id/download      same PNG as an attachment download
 *
 * Design notes:
 *  - Uploads are held in memory only (multer memoryStorage) — raw photos are
 *    never written to disk; only the final composed PNG is stored. The custom
 *    template and custom layout live in uploads/templates/ (git-ignored,
 *    survives deploys).
 *  - Every route is gated behind the existing requireAdmin middleware.
 *  - /generate is rate-limited per IP.
 *  - Errors map to JSON: 400 INVALID_* / MISSING_PHOTO, 413 upload too large,
 *    422 COORDINATE_OVERFLOW / INVALID_LAYOUT, 500 COMPOSE_FAILED.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');

const {
  composeCard, CardError, config: defaultConfig,
  getEffectiveLayout, getTemplatePath, getTemplate, scaleDefaultLayout,
  saveCustomLayout, resetCustomLayout, resetCustomTemplate,
} = require('./card-composer');
const { analyzeTemplatePng, normalizeAiLayout, mergeAiLayout, aiConfigured } = require('./card-ai');

const OUT_DIR = path.join(__dirname, 'uploads', 'cards');
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}

const MAX_CARDS_ON_DISK = 200; // prune the oldest outputs beyond this
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 15 * 1024 * 1024;
const ALLOWED_PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 12 },
});

const templateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TEMPLATE_BYTES, files: 1, fields: 4 },
});

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { ok: false, error: 'Too many card requests — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { ok: false, error: 'Too many AI requests — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Delete the oldest generated cards, keeping the most recent MAX_CARDS_ON_DISK. */
async function pruneOldCards() {
  try {
    const files = await fsp.readdir(OUT_DIR);
    if (files.length <= MAX_CARDS_ON_DISK) return;
    const withTime = await Promise.all(
      files.map(async (f) => ({ f, m: (await fsp.stat(path.join(OUT_DIR, f))).mtimeMs }))
    );
    withTime.sort((a, b) => b.m - a.m);
    await Promise.all(withTime.slice(MAX_CARDS_ON_DISK).map((e) => fsp.unlink(path.join(OUT_DIR, e.f)).catch(() => {})));
  } catch { /* pruning is best-effort */ }
}

/**
 * Validate a custom layout payload: photo box + every text field must be a
 * sensible rectangle inside the current template canvas.
 */
function validateLayoutPayload(body, canvas) {
  const err = (msg) => new CardError('INVALID_LAYOUT', msg, 422);
  const num = (v) => Number(v);
  const finite = (v) => Number.isFinite(v);

  const src = body.photo || {};
  const photo = {
    x: num(src.x), y: num(src.y),
    width: num(src.width), height: num(src.height),
    radius: src.radius === undefined ? defaultConfig.photo.radius : num(src.radius),
  };
  if (!['x', 'y', 'width', 'height', 'radius'].every((k) => finite(photo[k]) && photo[k] >= 0)) {
    throw err('photo: x, y, width, height and radius must be non-negative numbers');
  }
  if (photo.width < 20 || photo.height < 20) throw err('photo: box must be at least 20x20 px');
  if (photo.radius > Math.min(photo.width, photo.height) / 2) throw err('photo: radius is larger than the box');
  if (photo.x + photo.width > canvas.width || photo.y + photo.height > canvas.height) throw err('photo: box exceeds the template canvas');

  const fields = {};
  for (const [key, def] of Object.entries(defaultConfig.fields)) {
    const f = body.fields?.[key] || {};
    const cfg = {
      x: num(f.x), y: num(f.y),
      fontSize: num(f.fontSize), maxWidth: num(f.maxWidth),
      weight: def.weight, color: def.color,
    };
    if (!['x', 'y', 'fontSize', 'maxWidth'].every((k) => finite(cfg[k]) && cfg[k] >= 0)) {
      throw err(`fields.${key}: x, y, fontSize and maxWidth must be non-negative numbers`);
    }
    if (cfg.fontSize < 8 || cfg.fontSize > 400) throw err(`fields.${key}: fontSize must be between 8 and 400`);
    if (cfg.maxWidth < 20) throw err(`fields.${key}: maxWidth must be at least 20 px`);
    if (cfg.y < cfg.fontSize) throw err(`fields.${key}: y must be at least its fontSize (baseline position)`);
    if (cfg.x + cfg.maxWidth > canvas.width) throw err(`fields.${key}: exceeds the template canvas width`);
    fields[key] = cfg;
  }
  return { photo, fields };
}

/**
 * Build the router. `requireAdmin` is passed in from server.js so the card
 * endpoints share the exact same authentication as the rest of the admin API.
 */
function createCardRouter(requireAdmin) {
  const router = express.Router();
  const gate = requireAdmin || ((req, res, next) => next());

  /* ── POST /generate ─────────────────────────────────────────────────────── */

  router.post('/generate', generateLimiter, gate, upload.single('photo'), async (req, res, next) => {
    try {
      if (!req.file) throw new CardError('MISSING_PHOTO', 'A profile photo file is required', 400);
      if (!ALLOWED_PHOTO_MIME.has(req.file.mimetype)) {
        throw new CardError('INVALID_FILE_TYPE', 'Photo must be a JPEG, PNG or WebP image', 400);
      }
      const result = await composeCard({
        fields: req.body,
        photoBuffer: req.file.buffer,
        aiCorrect: req.body.aiCorrect !== 'false', // form checkbox can opt out per request
      });
      const id = crypto.randomBytes(6).toString('hex');
      await fsp.writeFile(path.join(OUT_DIR, `${id}.png`), result.png);
      pruneOldCards();
      res.json({
        ok: true,
        cardId: id,
        previewUrl: `/api/cards/${id}/preview`,
        downloadUrl: `/api/cards/${id}/download`,
        width: result.width,
        height: result.height,
        corrections: result.corrections,
        aiAvailable: result.aiAvailable,
        aiError: result.aiError || null,
      });
    } catch (err) {
      next(err);
    }
  });

  /* ── Layout: read effective / save custom / reset ──────────────────────── */

  router.get('/layout', gate, (req, res) => {
    const layout = getEffectiveLayout();
    const custom = fs.existsSync(require('./card-composer').CUSTOM_LAYOUT_FILE);
    res.json({
      ok: true,
      custom,
      template: getTemplatePath().endsWith('custom-template.png') ? 'custom' : 'starter',
      canvas: layout.canvas,
      photo: layout.photo,
      fields: layout.fields,
      aiAvailable: aiConfigured(),
    });
  });

  /* ── AI: read the template and auto-position the fields ────────────────── */

  router.post('/analyze-template', aiLimiter, gate, async (req, res, next) => {
    try {
      const template = await getTemplate(); // { buffer, width, height } of the ACTIVE template
      const raw = await analyzeTemplatePng(template.buffer);
      const fragment = normalizeAiLayout(raw, template.width, template.height);
      const merged = mergeAiLayout(fragment, getEffectiveLayout());
      saveCustomLayout(merged);
      res.json({
        ok: true,
        custom: true,
        canvas: merged.canvas,
        photo: merged.photo,
        fields: merged.fields,
        aiFound: Object.keys(fragment.fields),
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/layout', gate, (req, res, next) => {
    try {
      const current = getEffectiveLayout();
      const { photo, fields } = validateLayoutPayload(req.body || {}, current.canvas);
      saveCustomLayout({ canvas: current.canvas, photo, fields });
      res.json({ ok: true, custom: true, canvas: current.canvas, photo, fields });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/layout', gate, (req, res) => {
    resetCustomLayout();
    const layout = getEffectiveLayout();
    res.json({ ok: true, custom: false, canvas: layout.canvas, photo: layout.photo, fields: layout.fields });
  });

  /* ── Template: upload / remove ──────────────────────────────────────────── */

  router.post('/template', gate, templateUpload.single('template'), async (req, res, next) => {
    try {
      if (!req.file) throw new CardError('MISSING_TEMPLATE', 'A template image file is required', 400);
      if (!ALLOWED_PHOTO_MIME.has(req.file.mimetype)) {
        throw new CardError('INVALID_FILE_TYPE', 'Template must be a JPEG, PNG or WebP image', 400);
      }
      const meta = await sharp(req.file.buffer).metadata().catch(() => null);
      if (!meta || !meta.width || meta.width < 200 || meta.height < 200) {
        throw new CardError('INVALID_TEMPLATE', 'Template must be a valid image of at least 200x200 px', 400);
      }
      if (meta.width > 5000 || meta.height > 5000) {
        throw new CardError('INVALID_TEMPLATE', 'Template is too large (max 5000x5000 px)', 400);
      }
      const { CUSTOM_TEMPLATE, TEMPLATE_DIR } = require('./card-composer');
      fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
      await sharp(req.file.buffer).rotate().png().toFile(CUSTOM_TEMPLATE);
      // seed a scaled version of the default layout as a starting point
      const layout = scaleDefaultLayout({ width: meta.width, height: meta.height });
      saveCustomLayout(layout);
      res.json({ ok: true, custom: true, template: 'custom', canvas: layout.canvas, photo: layout.photo, fields: layout.fields });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/template', gate, (req, res) => {
    resetCustomTemplate();
    const layout = getEffectiveLayout();
    res.json({ ok: true, custom: false, template: 'starter', canvas: layout.canvas, photo: layout.photo, fields: layout.fields });
  });

  router.get('/template-preview', gate, (req, res) => {
    res.sendFile(getTemplatePath());
  });

  /* ── Generated card preview / download ─────────────────────────────────── */

  const ID_RE = /^[a-f0-9]{12}$/; // guards against path traversal

  router.get('/:id/preview', gate, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return next(new CardError('NOT_FOUND', 'Unknown card id', 404));
    res.set('Cache-Control', 'private, max-age=300');
    res.sendFile(path.join(OUT_DIR, `${req.params.id}.png`), (err) => err && next(err));
  });

  router.get('/:id/download', gate, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return next(new CardError('NOT_FOUND', 'Unknown card id', 404));
    res.download(
      path.join(OUT_DIR, `${req.params.id}.png`),
      `docseditor-card-${req.params.id}.png`,
      (err) => err && next(err)
    );
  });

  /* ── JSON error handler ─────────────────────────────────────────────────── */

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof CardError) {
      return res.status(err.status).json({ ok: false, code: err.code, message: err.message });
    }
    if (err instanceof multer.MulterError) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'UPLOAD_TOO_LARGE' : 'UPLOAD_ERROR';
      return res.status(413).json({ ok: false, code, message: 'File is too large (photo max 8 MB, template max 15 MB)' });
    }
    if (err && err.code === 'ENOENT') {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Card not found' });
    }
    console.error('[cards]', err);
    res.status(500).json({ ok: false, code: 'COMPOSE_FAILED', message: 'Could not generate the card' });
  });

  return router;
}

module.exports = { createCardRouter };
