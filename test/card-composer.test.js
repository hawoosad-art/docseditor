/**
 * Tests for the DocsEditor card composer (/api/cards/*).
 *
 * Spawns the real server (server.js) like the existing demo-card test, logs in
 * through /admin/login, then exercises the generate → preview → download flow
 * plus every documented error path. Pixel-level assertions prove the photo is
 * merged into its slot, the amber SAMPLE banner is stamped, and the name text
 * is actually rendered.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const sharp = require('sharp');

const { assertConfigFits, config } = require('../card-composer');

const ROOT = path.resolve(__dirname, '..');
const PORT = 33872;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { user: 'admin', pass: 'test-admin-pass-42' };

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(`Listening 0.0.0.0:${PORT}`)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (code !== null && !output.includes(`Listening 0.0.0.0:${PORT}`)) {
        clearTimeout(timer);
        reject(new Error(`server exited before starting (${code})`));
      }
    });
  });
}

function makePhoto() {
  // solid blue portrait so we can prove pixel-perfect placement later
  return sharp({ create: { width: 320, height: 400, channels: 4, background: { r: 30, g: 90, b: 180, alpha: 1 } } })
    .png().toBuffer();
}

function validForm(extra = {}) {
  const form = new FormData();
  form.set('name', 'Amani K. Otieno');
  form.set('dob', '14/03/1995');
  form.set('expiry', '08/2027');
  form.set('role', 'Community Member');
  Object.entries(extra).forEach(([k, v]) => form.set(k, v));
  return form;
}

async function regionAverage(png, left, top, width, height) {
  const { data } = await sharp(png)
    .extract({ left, top, width, height })
    .raw().toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  return { r: r / n, g: g / n, b: b / n };
}

async function regionStddev(png, left, top, width, height) {
  const { data } = await sharp(png)
    .extract({ left, top, width, height })
    .raw().toBuffer({ resolveWithObject: true });
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += gray; sum2 += gray * gray; n++;
  }
  const mean = sum / n;
  return Math.sqrt(sum2 / n - mean * mean);
}

/* ── unit: coordinate overflow guard ─────────────────────────────────────── */

test('assertConfigFits accepts the real template and rejects overflowing coordinates', () => {
  assert.equal(assertConfigFits(config.canvas.width, config.canvas.height), true);
  try {
    assertConfigFits(100, 100);
    assert.fail('expected COORDINATE_OVERFLOW');
  } catch (err) {
    assert.equal(err.code, 'COORDINATE_OVERFLOW');
    assert.equal(err.status, 422);
  }
});

/* ── integration: full server flow ───────────────────────────────────────── */

test('card endpoints: generate → preview → download, with stamp + photo + text verified', async (t) => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ADMIN_PASS: ADMIN.pass, OPENAI_API_KEY: '', DEMO_CARD_DISABLE_AI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForServer(child);

  // login through the existing admin endpoint, reuse the returned bearer token
  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  assert.equal(loginRes.status, 200);
  const { token } = await loginRes.json();
  assert.ok(token, 'login returns a token');
  const authHeaders = { 'Authorization': `Bearer ${token}` };

  // unauthenticated requests must be rejected
  const anon = await fetch(`${BASE}/api/cards/generate`, { method: 'POST', body: validForm() });
  assert.equal(anon.status, 401);

  // layout endpoint exposes the coordinate map
  const layoutRes = await fetch(`${BASE}/api/cards/layout`, { headers: authHeaders });
  assert.equal(layoutRes.status, 200);
  const layout = await layoutRes.json();
  assert.equal(layout.canvas.width, 1050);
  assert.deepEqual(Object.keys(layout.fields).sort(), ['dob', 'expiry', 'memberId', 'name', 'role']);

  // happy path
  const form = validForm();
  form.set('photo', new Blob([await makePhoto()], { type: 'image/png' }), 'photo.png');
  const created = await fetch(`${BASE}/api/cards/generate`, { method: 'POST', headers: authHeaders, body: form });
  assert.equal(created.status, 200);
  const payload = await created.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.watermark, 'SAMPLE — NOT AN OFFICIAL DOCUMENT');
  assert.equal(payload.width, 1050);
  assert.equal(payload.height, 660);
  assert.match(payload.cardId, /^[a-f0-9]{12}$/);

  // preview is a real 1050x660 PNG
  const preview = await fetch(`${BASE}${payload.previewUrl}`, { headers: authHeaders });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type') || '', /^image\/png/);
  const png = Buffer.from(await preview.arrayBuffer());
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 1050);
  assert.equal(meta.height, 660);

  // photo merged into its slot: sampled region is clearly blue-dominant
  const photoRegion = await regionAverage(png, config.photo.x + 30, config.photo.y + 40, 80, 80);
  assert.ok(photoRegion.b > photoRegion.r + 40, `photo present in slot (${JSON.stringify(photoRegion)})`);

  // name text rendered: high pixel variance where the value sits
  const nameField = config.fields.name;
  const textSd = await regionStddev(png, nameField.x, nameField.y - nameField.fontSize + 4, Math.min(360, nameField.maxWidth), nameField.fontSize - 6);
  assert.ok(textSd > 15, `name text rendered (stddev=${textSd.toFixed(1)})`);

  // amber SAMPLE banner stamped across the bottom
  const banner = config.watermark.banner;
  const bannerRegion = await regionAverage(png, 200, config.canvas.height - banner.height + 10, 300, banner.height - 20);
  assert.ok(bannerRegion.r > 200 && bannerRegion.g > 120 && bannerRegion.b < 100, `amber banner present (${JSON.stringify(bannerRegion)})`);

  // download is an attachment
  const download = await fetch(`${BASE}${payload.downloadUrl}`, { headers: authHeaders });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') || '', /attachment/);
});

test('card endpoints: validation errors map to documented codes', async (t) => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ADMIN_PASS: ADMIN.pass, OPENAI_API_KEY: '', DEMO_CARD_DISABLE_AI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForServer(child);

  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  const { token } = await (await loginRes.json());
  const authHeaders = { 'Authorization': `Bearer ${token}` };
  const photo = new Blob([await makePhoto()], { type: 'image/png' });

  async function post(form) {
    const res = await fetch(`${BASE}/api/cards/generate`, { method: 'POST', headers: authHeaders, body: form });
    return { status: res.status, body: await res.json() };
  }

  // missing photo
  let r = await post(validForm());
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'MISSING_PHOTO');

  // wrong file type
  const badType = validForm();
  badType.set('photo', new Blob(['not an image'], { type: 'text/plain' }), 'notes.txt');
  r = await post(badType);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_FILE_TYPE');

  // impossible dob (31 Feb) and nonsense dob format
  for (const dob of ['31/02/2001', '14-03-1995', 'yesterday']) {
    const f = validForm({ dob });
    f.set('photo', photo, 'photo.png');
    r = await post(f);
    assert.equal(r.status, 400, `dob ${dob}`);
    assert.equal(r.body.code, 'INVALID_DOB');
  }

  // expiry before dob / bad format
  for (const expiry of ['01/1990', '13/2030', '2030']) {
    const f = validForm({ expiry });
    f.set('photo', photo, 'photo.png');
    r = await post(f);
    assert.equal(r.status, 400, `expiry ${expiry}`);
    assert.equal(r.body.code, 'INVALID_EXPIRY');
  }

  // invalid name
  const badName = validForm({ name: '!!' });
  badName.set('photo', photo, 'photo.png');
  r = await post(badName);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_NAME');

  // unknown card id → 404
  const missing = await fetch(`${BASE}/api/cards/deadbeef0000/preview`, { headers: authHeaders });
  assert.equal(missing.status, 404);
});
