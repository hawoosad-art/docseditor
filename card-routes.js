/**
 * Express router: /api/cards/*
 *
 *   POST /generate          compose a card from multipart fields + photo upload
 *   GET  /layout            coordinate map (card-config.json) for the designer overlay
 *   GET  /template-preview  the base template PNG
 *   GET  /:id/preview       inline PNG preview of a generated card
 *   GET  /:id/download      same PNG as an attachment download
 *
 * Design notes:
 *  - Uploads are held in memory only (multer memoryStorage) — the raw user
 *    photo is never written to disk; only the final composed PNG is stored.
 *  - Every route is gated behind the existing requireAdmin middleware.
 *  - /generate is rate-limited per IP.
 *  - Errors map to JSON: 400 INVALID_* / MISSING_PHOTO, 413 upload too large,
 *    422 COORDINATE_OVERFLOW, 500 COMPOSE_FAILED.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const { composeCard, CardError, config } = require('./card-composer');

const OUT_DIR = path.join(__dirname, 'uploads', 'cards');
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}

const TEMPLATE_PATH = path.join(__dirname, config.template);
const MAX_CARDS_ON_DISK = 200; // prune the oldest outputs beyond this
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 12 },
});

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { ok: false, error: 'Too many card requests — try again later' },
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
      if (!ALLOWED_MIME.has(req.file.mimetype)) {
        throw new CardError('INVALID_FILE_TYPE', 'Photo must be a JPEG, PNG or WebP image', 400);
      }
      const result = await composeCard({ fields: req.body, photoBuffer: req.file.buffer });
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
        watermark: result.watermark,
      });
    } catch (err) {
      next(err);
    }
  });

  /* ── Static-ish helpers (registered before the :id routes) ─────────────── */

  router.get('/layout', gate, (req, res) => {
    res.json({
      ok: true,
      canvas: config.canvas,
      photo: config.photo,
      fields: config.fields,
      watermark: config.watermark.text,
    });
  });

  router.get('/template-preview', gate, (req, res) => {
    res.sendFile(TEMPLATE_PATH);
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
      return res.status(413).json({ ok: false, code, message: 'File is too large (max 8 MB)' });
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
