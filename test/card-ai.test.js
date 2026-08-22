/**
 * Unit tests for the AI card helpers (card-ai.js).
 *
 * The vision/text model calls themselves are not exercised here (no API key
 * in CI); instead we test the pure conversion/merge/correction logic with
 * synthetic model outputs, plus the graceful no-key behaviour.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAiLayout, mergeAiLayout, applyCorrections } = require('../card-ai');
const { getEffectiveLayout } = require('../card-composer');

test('normalizeAiLayout converts normalized AI boxes to a pixel layout', () => {
  const raw = {
    photo: { x: 0.75, y: 0.12, width: 0.18, height: 0.34, radius: 0.08 },
    fields: {
      name: { x: 0.08, y: 0.28, width: 0.55, height: 0.09 },
      dob: { x: 0.08, y: 0.52, width: 0.3, height: 0.06 },
    },
  };
  const frag = normalizeAiLayout(raw, 1000, 500);
  assert.equal(frag.photo.x, 750);
  assert.equal(frag.photo.y, 60);
  assert.equal(frag.photo.width, 180);
  assert.equal(frag.photo.height, 170);
  assert.ok(frag.photo.radius > 0 && frag.photo.radius <= 85, 'sane corner radius');
  assert.ok(frag.fields.name.fontSize > 0, 'font size derived');
  assert.ok(frag.fields.name.y > frag.fields.name.fontSize, 'baseline below box top');
  assert.equal(frag.fields.dob.x, 80);
  assert.equal(frag.fields.dob.maxWidth, 300);
});

test('normalizeAiLayout rejects garbage and missing photo, clamps out-of-range coords', () => {
  assert.throws(() => normalizeAiLayout(null, 100, 100), (e) => e.code === 'AI_BAD_RESPONSE');
  assert.throws(() => normalizeAiLayout({ photo: {}, fields: {} }, 100, 100), (e) => e.code === 'AI_BAD_RESPONSE');
  // out-of-range values are clamped into the canvas, not fatal
  const frag = normalizeAiLayout(
    { photo: { x: -5, y: 2, width: 0.5, height: 0.5 }, fields: { name: { x: -1, y: -1, width: 0.5, height: 0.1 } } },
    1000, 500
  );
  assert.ok(frag.photo.x >= 0);
  assert.ok(frag.photo.y + frag.photo.height <= 500);
});

test('mergeAiLayout keeps the current layout for fields the AI missed', () => {
  const current = getEffectiveLayout();
  const fragment = {
    photo: { x: 10, y: 10, width: 100, height: 120, radius: 8 },
    fields: { name: { x: 5, y: 40, fontSize: 30, maxWidth: 200 } },
  };
  const merged = mergeAiLayout(fragment, current);
  assert.equal(merged.photo.x, 10);
  assert.equal(merged.fields.name.x, 5);
  assert.equal(merged.fields.name.weight, current.fields.name.weight, 'styling preserved');
  assert.deepEqual(merged.fields.dob, current.fields.dob, 'missing fields kept');
  assert.deepEqual(merged.fields.expiry, current.fields.expiry);
});

test('applyCorrections applies only confident, matching, valid corrections', async () => {
  const fields = { name: 'JULIT', dob: '01/01/1990', expiry: '01/2027', role: 'Member', memberId: 'DE-1234' };
  const fakeCall = async () => ({
    corrections: [
      { field: 'name', from: 'JULIT', to: 'Juliet', confidence: 0.96, reason: 'common-name spelling' },
      { field: 'name', from: 'JULIT', to: 'Julius', confidence: 0.55, reason: 'low-confidence guess — must not apply' },
      { field: 'role', from: 'DifferentValue', to: 'Field Officer', confidence: 0.99, reason: 'from mismatch — must not apply' },
      { field: 'dob', from: '01/01/1990', to: '02/01/1990', confidence: 0.99, reason: 'dates must never change' },
    ],
  });
  const res = await applyCorrections(fields, { call: fakeCall });
  assert.equal(res.aiAvailable, true);
  assert.equal(res.corrections.length, 1);
  assert.equal(res.corrections[0].field, 'name');
  assert.equal(res.fields.name, 'JULIET', 'typo overwritten');
  assert.equal(res.fields.role, 'Member', 'unmatched correction ignored');
  assert.equal(res.fields.dob, '01/01/1990', 'dates untouched');
});

test('applyCorrections without an API key is a silent no-op', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const res = await applyCorrections({ name: 'JULIT', dob: '01/01/1990', expiry: '01/2027', role: 'Member', memberId: 'X' });
    assert.equal(res.aiAvailable, false);
    assert.deepEqual(res.corrections, []);
    assert.equal(res.fields.name, 'JULIT');
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
