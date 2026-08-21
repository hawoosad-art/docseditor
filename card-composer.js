/**
 * DocsEditor card composer — pure image-composition service (no external APIs).
 *
 * Pipeline:
 *   1. Validate the submitted text fields (name / dob / expiry / role / memberId)
 *      and the uploaded photo (JPEG/PNG/WebP, sane dimensions).
 *   2. Load the single base template (templates/base-card.png) and assert that
 *      every coordinate in card-config.json fits inside the canvas
 *      (this is the "coordinate overflow" guard).
 *   3. Fit + round the photo into the configured photo slot.
 *   4. Render the text fields at their configured baselines via an SVG overlay.
 *   5. Stamp the mandatory SAMPLE watermark (bottom banner + tiled diagonal
 *      text) on top of everything. This layer is intentionally not
 *      config-removable: outputs must never be mistakable for official
 *      documents.
 *
 * All drawing happens locally with sharp; no external generation service is
 * called, so no API keys are involved at all.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const config = require('./card-config.json');

const TEMPLATE_PATH = path.join(__dirname, config.template);
const FONT_FAMILY = "'DejaVu Sans', 'Liberation Sans', 'Noto Sans', Arial, sans-serif";
/** Rough average glyph advance for sans-serif fonts — used only to pre-shrink text. */
const AVG_GLYPH_WIDTH = 0.62;
/** Never render below this size; overflow is then clamped with textLength. */
const MIN_FONT_SIZE = 13;

/** Error with a machine-readable code + HTTP status, surfaced as JSON by the router. */
class CardError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CardError';
    this.code = code;
    this.status = status;
  }
}

/* ── Template loading (cached after first read) ──────────────────────────── */

let templateCache = null;
async function getTemplate() {
  if (!templateCache) {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new CardError('TEMPLATE_MISSING', 'Base template not found — run node scripts/make-base-template.js', 500);
    }
    const { data, info } = await sharp(TEMPLATE_PATH).png().toBuffer({ resolveWithObject: true });
    templateCache = { buffer: data, width: info.width, height: info.height };
  }
  return templateCache;
}

/* ── Coordinate overflow guard ────────────────────────────────────────────── */

/**
 * Throws COORDINATE_OVERFLOW (422) when any photo/text coordinate from
 * card-config.json lands outside the template canvas. Called before every
 * compose so a misconfigured layout fails loudly instead of silently
 * clipping the card.
 */
function assertConfigFits(templateWidth, templateHeight) {
  const errors = [];
  const check = (label, x, y, w, h) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0 || x < 0 || y < 0) {
      errors.push(`${label}: invalid bounds`);
    } else if (x + w > templateWidth || y + h > templateHeight) {
      errors.push(`${label}: overflows ${templateWidth}x${templateHeight}`);
    }
  };
  check('photo', config.photo.x, config.photo.y, config.photo.width, config.photo.height);
  for (const [name, f] of Object.entries(config.fields)) {
    // A field occupies maxWidth × fontSize, anchored at its baseline.
    check(`field.${name}`, f.x, f.y - f.fontSize, f.maxWidth, f.fontSize);
  }
  if (errors.length) {
    throw new CardError('COORDINATE_OVERFLOW', `card-config.json coordinates do not fit the template: ${errors.join('; ')}`, 422);
  }
  return true;
}

/* ── Input validation ─────────────────────────────────────────────────────── */

const RE_DATE_DMY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const RE_MONTH_YEAR = /^(0[1-9]|1[0-2])\/(\d{4})$/;

/** Parse DD/MM/YYYY, rejecting impossible dates like 31/02/2026. */
function parseDateDMY(value) {
  const m = RE_DATE_DMY.exec(String(value).trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const date = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
  if (date.getUTCDate() !== +dd || date.getUTCMonth() !== +mm - 1 || date.getUTCFullYear() !== +yyyy) return null;
  return date;
}

function clean(value, max, pattern, code) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!pattern.test(s)) throw new CardError(code, `Invalid value for ${code.replace('INVALID_', '').toLowerCase()}`, 400);
  return s.slice(0, max);
}

/**
 * Validates + normalises the form fields. Returns a sanitised object or throws
 * a CardError with a specific code for the router to translate into a 400.
 */
function parseAndValidate(raw) {
  const name = clean(raw.name, 40, /^[\p{L}][\p{L}\p{M} .'-]{1,39}$/u, 'INVALID_NAME');

  const dobRaw = String(raw.dob ?? '').trim();
  const dobDate = parseDateDMY(dobRaw);
  if (!dobDate) throw new CardError('INVALID_DOB', 'Date of birth must be a real date in DD/MM/YYYY format', 400);
  const now = new Date();
  if (dobDate > now) throw new CardError('INVALID_DOB', 'Date of birth cannot be in the future', 400);
  if (now.getUTCFullYear() - dobDate.getUTCFullYear() < 4) throw new CardError('INVALID_DOB', 'Date of birth is too recent', 400);

  const expiryRaw = String(raw.expiry ?? '').trim();
  if (!RE_MONTH_YEAR.test(expiryRaw)) throw new CardError('INVALID_EXPIRY', 'Expiry must be MM/YYYY', 400);
  const [expMonth, expYear] = expiryRaw.split('/').map(Number);
  const expTotal = expYear * 12 + expMonth;
  const dobTotal = dobDate.getUTCFullYear() * 12 + (dobDate.getUTCMonth() + 1);
  if (expTotal <= dobTotal) throw new CardError('INVALID_EXPIRY', 'Expiry must be after the date of birth', 400);
  if (expYear < 2000 || expYear > dobDate.getUTCFullYear() + 100) throw new CardError('INVALID_EXPIRY', 'Expiry year is out of range', 400);

  const role = clean(raw.role || 'Member', 32, /^[\p{L}\p{N} &'.,()/-]{2,32}$/u, 'INVALID_ROLE');
  const memberId = raw.memberId
    ? clean(raw.memberId, 24, /^[A-Za-z0-9-]{3,24}$/, 'INVALID_MEMBER_ID')
    : `DE-${Math.random().toString(36).slice(2, 10)}`;

  return {
    name: name.toUpperCase(),
    dob: dobRaw,
    expiry: expiryRaw,
    role,
    memberId: memberId.toUpperCase(),
  };
}

/* ── Photo preparation ────────────────────────────────────────────────────── */

/**
 * Auto-rotates (EXIF), cover-crops to the photo slot and applies the rounded
 * corner mask from card-config.json.photo.radius.
 */
async function preparePhoto(buffer) {
  const meta = await sharp(buffer).metadata().catch(() => null);
  if (!meta || !meta.width || !meta.height || meta.width < 60 || meta.height < 60) {
    throw new CardError('INVALID_PHOTO', 'Photo must be a valid image of at least 60x60 pixels', 400);
  }
  const { width: w, height: h, radius } = config.photo;
  const fitted = await sharp(buffer)
    .rotate() // honour EXIF orientation
    .resize(w, h, { fit: 'cover', position: 'attention' })
    .png()
    .toBuffer();
  const maskSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="#fff"/></svg>`
  );
  return sharp(fitted).composite([{ input: maskSvg, blend: 'dest-in' }]).png().toBuffer();
}

/* ── SVG overlay builders ─────────────────────────────────────────────────── */

function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Shrinks the font until the text is estimated to fit inside maxWidth.
 * If it still overflows at MIN_FONT_SIZE the SVG textLength attribute
 * hard-clamps the glyphs into the box.
 */
function fitFontSize(text, field) {
  let size = field.fontSize;
  while (size > MIN_FONT_SIZE && text.length * size * AVG_GLYPH_WIDTH > field.maxWidth) {
    size = Math.floor(size * 0.93);
  }
  const clamped = size <= MIN_FONT_SIZE;
  return { size: clamped ? MIN_FONT_SIZE : size, clamped };
}

function buildTextSvg(fields) {
  const parts = [];
  for (const [key, field] of Object.entries(config.fields)) {
    if (!(key in fields)) continue;
    const { size, clamped } = fitFontSize(fields[key], field);
    const hardClamp = clamped
      ? ` textLength="${field.maxWidth}" lengthAdjust="spacingAndGlyphs"`
      : '';
    parts.push(
      `<text x="${field.x}" y="${field.y}" font-family="${FONT_FAMILY}" font-size="${size}" ` +
      `font-weight="${field.weight}" fill="${field.color}"${hardClamp}>${xml(fields[key])}</text>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${config.canvas.width}" height="${config.canvas.height}">${parts.join('')}</svg>`;
}

/**
 * Mandatory SAMPLE watermark, drawn last so it sits on top of the photo and
 * every text field:
 *  - an amber banner across the bottom edge, and
 *  - a tiled diagonal repeat across the whole canvas (tamper-evident without
 *    ruining the design).
 */
function buildWatermarkSvg() {
  const { canvas: C, watermark: wm } = config;
  const parts = [];

  const step = wm.tile.spacing;
  for (let y = -260; y < C.height + 260; y += step) {
    for (let x = -260; x < C.width + 260; x += step) {
      parts.push(
        `<text x="${x}" y="${y}" transform="rotate(${wm.tile.angle} ${x} ${y})" ` +
        `font-family="${FONT_FAMILY}" font-size="${wm.tile.fontSize}" font-weight="700" ` +
        `fill="${wm.tile.color}" opacity="${wm.tile.opacity}" text-anchor="middle">${xml(wm.text)}</text>`
      );
    }
  }

  const b = wm.banner;
  const top = C.height - b.height;
  const baseline = top + (b.height + b.fontSize) / 2 - 6;
  parts.push(`<rect x="0" y="${top}" width="${C.width}" height="${b.height}" fill="${b.background}"/>`);
  parts.push(
    `<text x="${C.width / 2}" y="${baseline.toFixed(1)}" font-family="${FONT_FAMILY}" ` +
    `font-size="${b.fontSize}" font-weight="${b.weight}" fill="${b.textColor}" ` +
    `text-anchor="middle" letter-spacing="1.5">${xml(wm.text)}</text>`
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${C.width}" height="${C.height}">${parts.join('')}</svg>`;
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * Compose the final card.
 * @param {Object}   opts
 * @param {Object}   opts.fields       raw form fields: name, dob, expiry, role, memberId
 * @param {Buffer}   opts.photoBuffer  uploaded profile image (JPEG/PNG/WebP)
 * @returns {Promise<{png: Buffer, width: number, height: number, watermark: string}>}
 */
async function composeCard({ fields: rawFields, photoBuffer }) {
  if (!photoBuffer || !photoBuffer.length) {
    throw new CardError('MISSING_PHOTO', 'A profile photo (JPEG, PNG or WebP) is required', 400);
  }

  const fields = parseAndValidate(rawFields);
  const template = await getTemplate();
  assertConfigFits(template.width, template.height);

  const photo = await preparePhoto(photoBuffer);
  const textSvg = Buffer.from(buildTextSvg(fields));
  const watermarkSvg = Buffer.from(buildWatermarkSvg());

  const png = await sharp(template.buffer)
    .composite([
      { input: photo, left: config.photo.x, top: config.photo.y },
      { input: textSvg },
      { input: watermarkSvg },
    ])
    .png()
    .toBuffer();

  return { png, width: template.width, height: template.height, watermark: config.watermark.text };
}

module.exports = { composeCard, parseAndValidate, assertConfigFits, CardError, config };
