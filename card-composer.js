/**
 * DocsEditor card composer — pure image-composition service (no external APIs).
 *
 * Pipeline:
 *   1. Validate the submitted text fields (name / dob / expiry / role / memberId)
 *      and the uploaded photo (JPEG/PNG/WebP, sane dimensions).
 *   2. Load the template: the organization's uploaded template
 *      (uploads/templates/custom-template.png) when present, otherwise the
 *      bundled starter template (templates/base-card.png).
 *   3. Load the layout: the admin-saved custom coordinate map
 *      (uploads/templates/custom-layout.json) when present, otherwise
 *      card-config.json. Coordinates are checked against the template canvas
 *      (the "coordinate overflow" guard).
 *   4. Fit + round the photo into the configured photo slot.
 *   5. Render the text fields at their configured baselines via an SVG overlay.
 *
 * The output is exactly the organization's template with the user's data
 * dropped into the configured boxes — no extra branding is added.
 *
 * All drawing happens locally with sharp; no external generation service is
 * called, so no API keys are involved at all.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const defaultConfig = require('./card-config.json');

const TEMPLATE_DIR = path.join(__dirname, 'uploads', 'templates');
const DEFAULT_TEMPLATE = path.join(__dirname, defaultConfig.template);
const CUSTOM_TEMPLATE = path.join(TEMPLATE_DIR, 'custom-template.png');
const CUSTOM_LAYOUT_FILE = path.join(TEMPLATE_DIR, 'custom-layout.json');

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

/* ── Custom template / layout persistence ────────────────────────────────── */

function templateExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** The template that will actually be composed onto. */
function getTemplatePath() {
  return templateExists(CUSTOM_TEMPLATE) ? CUSTOM_TEMPLATE : DEFAULT_TEMPLATE;
}

function readCustomLayout() {
  try { return JSON.parse(fs.readFileSync(CUSTOM_LAYOUT_FILE, 'utf8')); } catch { return null; }
}

function saveCustomLayout(layout) {
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  fs.writeFileSync(CUSTOM_LAYOUT_FILE, JSON.stringify(layout, null, 2));
}

function resetCustomLayout() {
  try { fs.unlinkSync(CUSTOM_LAYOUT_FILE); } catch {}
}

/** Removes the uploaded template AND its layout — full reset to the starter. */
function resetCustomTemplate() {
  resetCustomLayout();
  try { fs.unlinkSync(CUSTOM_TEMPLATE); } catch {}
}

/**
 * Effective layout: card-config.json defaults overlaid with the admin-saved
 * custom coordinate map (custom values win per field; styling falls back to
 * defaults for anything unspecified).
 */
function getEffectiveLayout() {
  const custom = readCustomLayout();
  if (!custom) return defaultConfig;
  const layout = {
    canvas: { ...defaultConfig.canvas, ...(custom.canvas || {}) },
    photo: { ...defaultConfig.photo, ...(custom.photo || {}) },
    fields: {},
  };
  for (const [key, def] of Object.entries(defaultConfig.fields)) {
    layout.fields[key] = { ...def, ...((custom.fields && custom.fields[key]) || {}) };
  }
  return layout;
}

/**
 * Scale the default coordinate map onto a newly uploaded template so the
 * admin gets a sane starting point to drag around instead of a blank slate.
 */
function scaleDefaultLayout({ width, height }) {
  const fx = width / defaultConfig.canvas.width;
  const fy = height / defaultConfig.canvas.height;
  const fs = Math.min(fx, fy);
  const round = (v) => Math.round(v * 10) / 10;
  return {
    canvas: { width, height },
    photo: {
      x: round(defaultConfig.photo.x * fx),
      y: round(defaultConfig.photo.y * fy),
      width: round(defaultConfig.photo.width * fx),
      height: round(defaultConfig.photo.height * fy),
      radius: Math.min(50, Math.max(0, round(defaultConfig.photo.radius * fs))),
    },
    fields: Object.fromEntries(
      Object.entries(defaultConfig.fields).map(([key, f]) => [
        key,
        {
          x: round(f.x * fx),
          y: round(f.y * fy),
          fontSize: Math.max(10, round(f.fontSize * fs)),
          maxWidth: round(f.maxWidth * fx),
          weight: f.weight,
          color: f.color,
        },
      ])
    ),
  };
}

/* ── Template loading (cached by path + mtime) ───────────────────────────── */

let templateCache = { path: null, mtimeMs: 0, buffer: null, width: 0, height: 0 };

async function getTemplate() {
  const templatePath = getTemplatePath();
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(templatePath).mtimeMs; } catch {
    throw new CardError('TEMPLATE_MISSING', 'No template available — upload one or run node scripts/make-base-template.js', 500);
  }
  if (templateCache.path !== templatePath || templateCache.mtimeMs !== mtimeMs) {
    const { data, info } = await sharp(templatePath).png().toBuffer({ resolveWithObject: true });
    templateCache = { path: templatePath, mtimeMs, buffer: data, width: info.width, height: info.height };
  }
  return templateCache;
}

/* ── Coordinate overflow guard ────────────────────────────────────────────── */

/**
 * Throws COORDINATE_OVERFLOW (422) when any photo/text coordinate from the
 * layout lands outside the template canvas. Called before every compose so a
 * misconfigured layout fails loudly instead of silently clipping the card.
 */
function assertConfigFits(layout, templateWidth, templateHeight) {
  const errors = [];
  const check = (label, x, y, w, h) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0 || x < 0 || y < 0) {
      errors.push(`${label}: invalid bounds`);
    } else if (x + w > templateWidth || y + h > templateHeight) {
      errors.push(`${label}: overflows ${templateWidth}x${templateHeight}`);
    }
  };
  check('photo', layout.photo.x, layout.photo.y, layout.photo.width, layout.photo.height);
  for (const [name, f] of Object.entries(layout.fields)) {
    // A field occupies maxWidth × fontSize, anchored at its baseline.
    check(`field.${name}`, f.x, f.y - f.fontSize, f.maxWidth, f.fontSize);
  }
  if (errors.length) {
    throw new CardError('COORDINATE_OVERFLOW', `Layout coordinates do not fit the template: ${errors.join('; ')}`, 422);
  }
  return true;
}

/* ── Input validation ─────────────────────────────────────────────────────── */

const RE_DATE_DMY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const RE_MONTH_YEAR = /^(0[1-9]|1[0-2])\/(\d{4})$/;

/** Field rules used by both parseAndValidate and the AI correction layer. */
const FIELD_RULES = {
  name: [/^[\p{L}][\p{L}\p{M} .'-]{1,39}$/u, 40, 'INVALID_NAME'],
  role: [/^[\p{L}\p{N} &'.,()/-]{2,32}$/u, 32, 'INVALID_ROLE'],
};

/** Parse DD/MM/YYYY, rejecting impossible dates like 31/02/2026. */
function parseDateDMY(value) {
  const m = RE_DATE_DMY.exec(String(value).trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const date = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
  if (date.getUTCDate() !== +dd || date.getUTCMonth() !== +mm - 1 || date.getUTCFullYear() !== +yyyy) return null;
  return date;
}

function clean(key, value) {
  const [pattern, max, code] = FIELD_RULES[key];
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!pattern.test(s)) throw new CardError(code, `Invalid value for ${code.replace('INVALID_', '').toLowerCase()}`, 400);
  return s.slice(0, max);
}

/** Non-throwing variant used by the AI correction layer; null when invalid. */
function sanitizeFieldValue(key, value) {
  if (!FIELD_RULES[key]) return null;
  try { return clean(key, value); } catch { return null; }
}

/**
 * Validates + normalises the form fields. Returns a sanitised object or throws
 * a CardError with a specific code for the router to translate into a 400.
 */
function parseAndValidate(raw) {
  const name = clean('name', raw.name);

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

  const role = clean('role', raw.role || 'Member');
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
 * corner mask from the layout's photo radius.
 */
async function preparePhoto(buffer, photoCfg) {
  const meta = await sharp(buffer).metadata().catch(() => null);
  if (!meta || !meta.width || !meta.height || meta.width < 60 || meta.height < 60) {
    throw new CardError('INVALID_PHOTO', 'Photo must be a valid image of at least 60x60 pixels', 400);
  }
  const { width: w, height: h, radius } = photoCfg;
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

/* ── SVG text overlay ─────────────────────────────────────────────────────── */

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

function buildTextSvg(fields, layout) {
  const parts = [];
  for (const [key, field] of Object.entries(layout.fields)) {
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.canvas.width}" height="${layout.canvas.height}">${parts.join('')}</svg>`;
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * Compose the final card.
 * @param {Object}   opts
 * @param {Object}   opts.fields       raw form fields: name, dob, expiry, role, memberId
 * @param {Buffer}   opts.photoBuffer  uploaded profile image (JPEG/PNG/WebP)
 * @param {boolean}  [opts.aiCorrect]  let the AI proofread the fields first (default true)
 * @returns {Promise<{png: Buffer, width: number, height: number, corrections: Array, aiAvailable: boolean}>}
 */
async function composeCard({ fields: rawFields, photoBuffer, aiCorrect = true }) {
  if (!photoBuffer || !photoBuffer.length) {
    throw new CardError('MISSING_PHOTO', 'A profile photo (JPEG, PNG or WebP) is required', 400);
  }

  let fields = parseAndValidate(rawFields);

  // Optional AI proofreading pass (fixes typos like "Julit" → "Juliet").
  // Lazily required to avoid a module cycle with card-ai.js.
  let corrections = [];
  let aiAvailable = false;
  let aiError = null;
  if (aiCorrect) {
    const { applyCorrections } = require('./card-ai');
    const review = await applyCorrections(fields);
    fields = review.fields;
    corrections = review.corrections;
    aiAvailable = review.aiAvailable;
    aiError = review.aiError || null;
  }

  const layout = getEffectiveLayout();
  const template = await getTemplate();
  assertConfigFits(layout, template.width, template.height);

  const photo = await preparePhoto(photoBuffer, layout.photo);
  const textSvg = Buffer.from(buildTextSvg(fields, layout));

  const png = await sharp(template.buffer)
    .composite([
      { input: photo, left: layout.photo.x, top: layout.photo.y },
      { input: textSvg },
    ])
    .png()
    .toBuffer();

  return { png, width: template.width, height: template.height, corrections, aiAvailable, aiError };
}

module.exports = {
  composeCard,
  parseAndValidate,
  assertConfigFits,
  CardError,
  config: defaultConfig,
  sanitizeFieldValue,
  // custom template/layout management
  getEffectiveLayout,
  getTemplatePath,
  getTemplate,
  scaleDefaultLayout,
  saveCustomLayout,
  resetCustomLayout,
  resetCustomTemplate,
  TEMPLATE_DIR,
  CUSTOM_TEMPLATE,
  CUSTOM_LAYOUT_FILE,
  DEFAULT_TEMPLATE,
};
