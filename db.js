// db.js — simple JSON file DB, no native deps. Atomic write + in-memory cache.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'db.json');

function ensureDb() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const init = {
      keys: [],
      activations: [], // { keyId, keyText, deviceId, androidId, wifiIp, bssid, buildFp, token, createdAt, expiresAt, lastSeen }
      meta: { createdAt: new Date().toISOString() }
    };
    // seed with demo keys so admin can test immediately
    const now = Date.now();
    init.keys.push(
      {
        id: 1,
        key: "DEMO-TRIAL-9999",
        max_devices: 1,
        status: "active",
        is_trial: true,
        is_paid: false,
        expires_at: null, // trial expiry is per-activation (1h)
        created_at: new Date().toISOString(),
        note: "Demo trial key"
      },
      {
        id: 2,
        key: "FACE-DEMO-PAID-001",
        max_devices: 3,
        status: "active",
        is_trial: false,
        is_paid: true,
        expires_at: new Date(now + 30*24*3600*1000).toISOString(),
        created_at: new Date().toISOString(),
        note: "Demo paid key 30 days, 3 devices"
      },
      {
        id: 999,
        key: "NOWORNEVER",
        max_devices: 1,
        status: "active",
        is_trial: true,
        is_paid: false,
        expires_at: null,
        created_at: new Date().toISOString(),
        note: "Hardcoded trial key FACEGATE_TRIAL_KEY"
      }
    );
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
  }
}

let cache = null;
function load() {
  ensureDb();
  if (cache) return cache;
  cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return cache;
}
function save() {
  if (!cache) return;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// helpers
function findKey(keyText) {
  const db = load();
  return db.keys.find(k => k.key === keyText);
}
function findKeyById(id) {
  const db = load();
  return db.keys.find(k => k.id === id);
}
function listKeys() {
  return load().keys;
}
function createKey({ key, max_devices = 1, is_trial = false, is_paid = true, days = 30, status = 'active', note = '' }) {
  const db = load();
  if (db.keys.some(k => k.key === key)) throw new Error('Key already exists');
  const id = db.keys.length ? Math.max(...db.keys.map(k => k.id)) + 1 : 1;
  const expires_at = is_trial ? null : (days === 0 ? null : new Date(Date.now() + days*24*3600*1000).toISOString());
  const rec = { id, key, max_devices, status, is_trial, is_paid, expires_at, created_at: new Date().toISOString(), note };
  db.keys.push(rec);
  save();
  return rec;
}
function updateKey(id, patch) {
  const db = load();
  const k = db.keys.find(x => x.id === id);
  if (!k) throw new Error('Key not found');
  Object.assign(k, patch);
  save();
  return k;
}
function deleteKey(id) {
  const db = load();
  const idx = db.keys.findIndex(x => x.id === id);
  if (idx === -1) throw new Error('Key not found');
  db.keys.splice(idx, 1);
  // also remove activations for that key
  const keyText = db.keys[idx]?.key;
  db.activations = db.activations.filter(a => a.keyId !== id);
  save();
}

function getActivationsForKey(keyText) {
  const db = load();
  return db.activations.filter(a => a.keyText === keyText);
}
function countActiveDevices(keyText) {
  return getActivationsForKey(keyText).length;
}
function findActivation(deviceId, keyText) {
  const db = load();
  return db.activations.find(a => a.deviceId === deviceId && a.keyText === keyText);
}
function findActivationByToken(token) {
  const db = load();
  return db.activations.find(a => a.token === token);
}
function findActivationByDevice(deviceId) {
  const db = load();
  // return latest for device
  return db.activations.find(a => a.deviceId === deviceId);
}
function upsertActivation({ keyId, keyText, deviceId, androidId, wifiIp, bssid, buildFp, token, expiresAt }) {
  const db = load();
  let act = db.activations.find(a => a.deviceId === deviceId && a.keyText === keyText);
  const now = new Date().toISOString();
  if (act) {
    act.androidId = androidId || act.androidId;
    act.wifiIp = wifiIp || act.wifiIp;
    act.bssid = bssid || act.bssid;
    act.buildFp = buildFp || act.buildFp;
    act.token = token || act.token;
    act.expiresAt = expiresAt || act.expiresAt;
    act.lastSeen = now;
  } else {
    act = { keyId, keyText, deviceId, androidId, wifiIp, bssid, buildFp, token, createdAt: now, expiresAt, lastSeen: now };
    db.activations.push(act);
  }
  save();
  return act;
}
function touchActivation(token) {
  const db = load();
  const act = db.activations.find(a => a.token === token);
  if (act) { act.lastSeen = new Date().toISOString(); save(); }
  return act;
}
function removeExpired() {
  const db = load();
  const now = Date.now();
  const before = db.activations.length;
  db.activations = db.activations.filter(a => {
    if (!a.expiresAt) return true;
    return new Date(a.expiresAt).getTime() > now;
  });
  if (db.activations.length !== before) save();
  // Delete 1-hour trial keys exactly 1 hour after they were FIRST ACTIVATED
  // (not from creation). This closes the loophole where a user could re-activate
  // the same trial key repeatedly for free.
  const keysBefore = db.keys.length;
  const oneHour = 60 * 60 * 1000;
  db.keys = db.keys.filter(k => {
    if (!k.is_trial) return true;          // only trial keys
    if (!k.activated_at) return true;       // never activated -> keep (unused)
    return now - new Date(k.activated_at).getTime() < oneHour;
  });
  if (db.keys.length !== keysBefore) {
    save();
    // also drop any activations tied to deleted trial keys
    const keySet = new Set(db.keys.map(k => k.key));
    db.activations = db.activations.filter(a => keySet.has(a.keyText));
    save();
  }
}

// Mark a trial key as activated (called on first successful activation).
function markKeyActivated(keyText) {
  const data = load();
  const k = data.keys.find(x => x.key === keyText);
  if (k && !k.activated_at) {
    k.activated_at = new Date().toISOString();
    save();
  }
  return k;
}
function revokeDevice(deviceId, keyText) {
  const db = load();
  const idx = db.activations.findIndex(a => a.deviceId === deviceId && a.keyText === keyText);
  if (idx !== -1) { db.activations.splice(idx, 1); save(); return true; }
  return false;
}

function generateToken(deviceId, keyText, keyId) {
  // replicate native: hmac(secret, "facegate:paid:deviceId:keyId:keyText")
  // but for simplicity also support trial tokens; we use same logic for all
  const { hmacSha256Hex, FACEGATE_HMAC_SECRET } = require('./envelope');
  const raw = `facegate:paid:${deviceId}:${keyId}:${keyText}`;
  return hmacSha256Hex(FACEGATE_HMAC_SECRET, raw);
}

function listActivations() {
  return load().activations;
}

// List trial keys with their activation status (who activated, time remaining).
// Returned for the bot admin panel. remaining_ms = time left until trial ends.
function listTrialActivations() {
  const db = load();
  const now = Date.now();
  const out = [];
  for (const k of db.keys) {
    if (!k.is_trial) continue;
    // find the activation(s) for this key
    const acts = db.activations.filter(a => a.keyText === k.key);
    if (acts.length === 0) {
      // issued but not yet activated in the app
      out.push({
        key: k.key,
        deviceId: "",
        wifiIp: "",
        androidId: "",
        activated_at: k.activated_at || null,
        expiresAt: null,
        remaining_ms: null,
        created_at: k.created_at || null
      });
      continue;
    }
    for (const a of acts) {
      let remaining_ms = null;
      if (a.expiresAt) remaining_ms = Math.max(0, new Date(a.expiresAt).getTime() - now);
      out.push({
        key: k.key,
        deviceId: a.deviceId || "",
        wifiIp: a.wifiIp || "",
        androidId: a.androidId || "",
        activated_at: k.activated_at || a.createdAt || null,
        expiresAt: a.expiresAt || null,
        remaining_ms: remaining_ms,
        created_at: k.created_at || null
      });
    }
  }
  // sort by most recently created/activated first
  out.sort((a,b)=> (new Date(b.activated_at||b.created_at||0)).getTime() - (new Date(a.activated_at||a.created_at||0)).getTime());
  return out;
}

// Reset a trial key so the user can re-use it for another 1 hour:
// clears the activation + activated_at, so it behaves like a fresh (unused) trial.
function resetTrial(keyText) {
  const db = load();
  const k = db.keys.find(x => x.key === keyText);
  if (!k) return false;
  k.activated_at = null;
  db.activations = db.activations.filter(a => a.keyText !== keyText);
  save();
  return true;
}

// Get device/activation detail for a given trial key.
function getTrialActivation(keyText) {
  const db = load();
  const k = db.keys.find(x => x.key === keyText);
  if (!k) return null;
  const a = db.activations.find(x => x.keyText === keyText);
  const now = Date.now();
  let remaining_ms = null;
  if (a && a.expiresAt) remaining_ms = Math.max(0, new Date(a.expiresAt).getTime() - now);
  return {
    key: keyText,
    deviceId: a?.deviceId || "",
    wifiIp: a?.wifiIp || "",
    androidId: a?.androidId || "",
    activated_at: k.activated_at || null,
    expiresAt: a?.expiresAt || null,
    remaining_ms: remaining_ms,
    is_activated: !!k.activated_at
  };
}

function stats() {
  const db = load();
  return {
    totalKeys: db.keys.length,
    activeKeys: db.keys.filter(k => k.status === 'active').length,
    totalActivations: db.activations.length,
    trialKeys: db.keys.filter(k => k.is_trial).length
  };
}

module.exports = {
  load, save,
  findKey, findKeyById, listKeys, createKey, updateKey, deleteKey,
  getActivationsForKey, countActiveDevices, findActivation, findActivationByToken, findActivationByDevice,
  upsertActivation, touchActivation, removeExpired, revokeDevice,
  generateToken, listActivations, listTrialActivations, resetTrial, getTrialActivation,
  stats, markKeyActivated
};
