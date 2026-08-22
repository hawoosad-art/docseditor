/**
 * AI helpers for the card designer (optional — everything degrades gracefully
 * without an API key).
 *
 *  - analyzeTemplatePng(): vision pass over the active template image that
 *    finds the photo slot and every field's VALUE area (the blank space next
 *    to or under each printed label), returned as a pixel-coordinate layout.
 *  - applyCorrections(): proofreading pass over the entered fields that fixes
 *    only unambiguous typos (e.g. "Julit" → "Juliet") before printing.
 *
 * Both use the OpenAI API through the repo's existing `openai` dependency.
 * Missing key, network failure, or bad model output never breaks card
 * generation — the manual drag-and-drop layout and plain compose still work.
 */
const OpenAI = require('openai');
const { CardError, sanitizeFieldValue } = require('./card-composer');

const CORRECTION_FIELDS = ['name', 'role'];
const CORRECTION_MIN_CONFIDENCE = 0.9;

function aiDisabled() { return process.env.CARD_AI_DISABLE === '1'; }
function aiConfigured() { return !!(process.env.OPENAI_API_KEY) && !aiDisabled(); }
function correctionsEnabled() { return process.env.CARD_AI_CORRECT !== '0' && !aiDisabled(); }

function client() {
  if (!process.env.OPENAI_API_KEY || aiDisabled()) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* ── 1) Template reading (vision) ────────────────────────────────────────── */

const VISION_SYSTEM_PROMPT = [
  'You locate where card-holder data belongs on an ID card template image.',
  'Return a single JSON object, nothing else:',
  '{',
  '  "photo": {"x":0..1,"y":0..1,"width":0..1,"height":0..1,"radius":0..1},',
  '  "fields": {',
  '    "name":    {"x":0..1,"y":0..1,"width":0..1,"height":0..1},',
  '    "dob":     {"x":0..1,"y":0..1,"width":0..1,"height":0..1},',
  '    "expiry":  {"x":0..1,"y":0..1,"width":0..1,"height":0..1},',
  '    "role":    {"x":0..1,"y":0..1,"width":0..1,"height":0..1},',
  '    "memberId":{"x":0..1,"y":0..1,"width":0..1,"height":0..1}',
  '  }',
  '}',
  'All coordinates are NORMALIZED: 0 to 1 relative to the image width and height, 3 decimals.',
  '"photo" is the bounding box of the photo/portrait placeholder (empty rectangle, silhouette or camera icon). "radius" is the corner-rounding radius as a fraction of the box width.',
  'For every field: first find its printed label (NAME / FULL NAME, DATE OF BIRTH / DOB / BIRTH DATE, EXPIRY / EXPIRES / VALID UNTIL, ROLE / DESIGNATION / TITLE / DEPARTMENT, ID NO / STAFF NO / EMPLOYEE NO / MEMBER ID). Then return the box of the EMPTY AREA next to or under that label where the actual printed value belongs — the value box, NOT the label box.',
  'If a label is printed to the left of its value, the value box starts just right of the label text.',
  'Return every field you can find; if a field truly has no label or area, omit it.',
  'Never invent text content; only geometry. Use numbers only.',
].join('\n');

/**
 * Send the template PNG to the vision model and return the raw JSON answer.
 * Throws AI_UNAVAILABLE (503) when there is no key / the call fails.
 */
async function analyzeTemplatePng(pngBuffer) {
  const ai = client();
  if (!ai) {
    throw new CardError(
      'AI_UNAVAILABLE',
      'AI is not configured: set OPENAI_API_KEY in the environment (.env) and restart the app',
      503
    );
  }
  const model = process.env.OPENAI_VISION_MODEL || 'gpt-5-mini';
  const base64 = pngBuffer.toString('base64');
  let content;
  try {
    const res = await ai.chat.completions.create({
      model,
      max_completion_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the template. Return the JSON coordinate mapping.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        },
      ],
    });
    content = res.choices?.[0]?.message?.content || '';
  } catch (err) {
    throw new CardError('AI_UNAVAILABLE', `Template analysis failed: ${String(err.message || err).slice(0, 140)}`, 503);
  }
  let raw;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new CardError('AI_BAD_RESPONSE', 'The AI returned unreadable data — try again, or drag the boxes into place manually', 422);
  }
  return raw;
}

/* ── Layout conversion (pure — unit-testable) ────────────────────────────── */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Convert the vision model's normalized answer into a pixel layout fragment.
 * Out-of-range coordinates are clamped into the canvas; fields the AI did not
 * find are omitted so the caller can merge them from the current layout.
 */
function normalizeAiLayout(raw, width, height) {
  const bad = () => {
    throw new CardError(
      'AI_BAD_RESPONSE',
      'The AI could not locate the fields reliably — try again, or drag the boxes into place manually',
      422
    );
  };
  if (!raw || typeof raw !== 'object') bad();

  const fragment = { photo: null, fields: {} };

  const p = raw.photo || {};
  const px = num(p.x), py = num(p.y), pw = num(p.width), ph = num(p.height);
  if ([px, py, pw, ph].some((v) => v === null) || pw < 0.015 || ph < 0.015) bad(); // photo box is required
  const pLeft = clamp01(px), pTop = clamp01(py);
  const pWidthPx = Math.round(Math.min(pw, 1 - pLeft) * width);
  const pHeightPx = Math.round(Math.min(ph, 1 - pTop) * height);
  const radFrac = num(p.radius) === null ? 0.06 : clamp01(num(p.radius));
  fragment.photo = {
    x: Math.round(pLeft * width),
    y: Math.round(pTop * height),
    width: pWidthPx,
    height: pHeightPx,
    radius: Math.max(0, Math.min(Math.round(radFrac * pWidthPx), Math.floor(Math.min(pWidthPx, pHeightPx) / 2))),
  };

  const fieldsRaw = raw.fields || {};
  for (const key of ['name', 'dob', 'expiry', 'role', 'memberId']) {
    const f = fieldsRaw[key];
    if (!f || typeof f !== 'object') continue;
    const fx = num(f.x), fy = num(f.y), fw = num(f.width), fh = num(f.height);
    if ([fx, fy, fw, fh].some((v) => v === null) || fw < 0.02 || fh < 0.008) continue; // skip unusable fields
    const fLeft = clamp01(fx), fTop = clamp01(fy);
    const wPx = Math.round(Math.min(fw, 1 - fLeft) * width);
    const hPx = Math.round(Math.min(fh, 1 - fTop) * height);
    const fontSize = Math.min(180, Math.max(10, Math.round(hPx * 0.66)));
    fragment.fields[key] = {
      x: Math.round(fLeft * width),
      y: Math.round(fTop * height) + Math.round(hPx * 0.72), // SVG text baseline
      fontSize,
      maxWidth: Math.max(20, wPx),
    };
  }

  if (!fragment.photo || Object.keys(fragment.fields).length === 0) bad();
  return fragment;
}

/**
 * Merge the AI fragment into the current layout: fields the AI found win
 * (keeping the current styling); everything else stays as it was.
 */
function mergeAiLayout(fragment, current) {
  const fields = {};
  for (const [key, f] of Object.entries(current.fields)) {
    const aiF = fragment.fields[key];
    fields[key] = aiF ? { weight: f.weight, color: f.color, ...aiF } : f;
  }
  return { canvas: current.canvas, photo: fragment.photo || current.photo, fields };
}

/* ── 2) Typo proofreading (text) ─────────────────────────────────────────── */

const CORRECTION_SYSTEM_PROMPT = [
  'You proofread data entered for a staff/worker ID card and fix ONLY clear typographical errors.',
  'Rules:',
  '- Correct obvious misspellings in the person\'s name when the intended spelling is unambiguous: "JULIT" → "JULIET", "JONH" → "JOHN", doubled letters "AMANII" → "AMANI".',
  '- Correct obvious typos and casing in the role text ("field officerr" → "Field Officer").',
  '- NEVER alter dates, IDs or numbers — format problems are handled elsewhere.',
  '- NEVER change a name that is plausibly correct, including uncommon or non-English names.',
  '- Only include a correction when you are at least 90% confident.',
  'Return JSON: {"corrections":[{"field":"name","from":"JULIT","to":"JULIET","confidence":0.96,"reason":"common-name spelling"}]}',
  'If nothing needs fixing return {"corrections":[]}.',
].join('\n');

/**
 * Review the parsed fields and apply only high-confidence, unambiguous fixes.
 * Returns { fields, corrections, aiAvailable, aiError }.
 * `opts.call` lets tests inject the model call.
 */
async function applyCorrections(parsedFields, opts = {}) {
  const fields = { ...parsedFields };
  const ai = opts.call ? true : client();
  if (!correctionsEnabled() || !ai) {
    return { fields, corrections: [], aiAvailable: false };
  }

  let data;
  try {
    if (opts.call) {
      data = await opts.call(fields);
    } else {
      const res = await ai.chat.completions.create({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-5-mini',
        max_completion_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CORRECTION_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(fields) },
        ],
      });
      data = JSON.parse(res.choices?.[0]?.message?.content || '{}');
    }
  } catch (err) {
    return { fields, corrections: [], aiAvailable: true, aiError: String(err.message || err).slice(0, 160) };
  }

  const applied = [];
  for (const c of Array.isArray(data.corrections) ? data.corrections : []) {
    if (!CORRECTION_FIELDS.includes(c.field)) continue;          // never touch dates/ids
    if (typeof c.from !== 'string' || typeof c.to !== 'string') continue;
    if (Number(c.confidence) < CORRECTION_MIN_CONFIDENCE) continue;
    if (c.from !== fields[c.field]) continue;                    // only overwrite what was actually submitted
    const clean = sanitizeFieldValue(c.field, c.to);
    if (!clean || clean === fields[c.field]) continue;
    fields[c.field] = c.field === 'name' ? clean.toUpperCase() : clean;
    applied.push({
      field: c.field,
      from: c.from,
      to: fields[c.field],
      confidence: Number(c.confidence),
      reason: String(c.reason || '').slice(0, 120),
    });
  }
  return { fields, corrections: applied, aiAvailable: true };
}

module.exports = {
  analyzeTemplatePng,
  normalizeAiLayout,
  mergeAiLayout,
  applyCorrections,
  aiConfigured,
};
