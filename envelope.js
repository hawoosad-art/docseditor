// envelope.js — exact port of C++ verify_envelope / json_canonical / HMAC logic
// FACEGATE_HMAC_SECRET must match native header
const crypto = require('crypto');

const FACEGATE_HMAC_SECRET = "a7f3c9e1b8d4025f6a4b9c0e7d1f8a3b5c2e6d9f0a1b4c7d8e2f5a9b3c6d0e7f";

// C++ json_escape: escapes " , \ , \b , \f , else if c < 0x20 => \uXXXX, else raw
function jsonEscape(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';        // "
    else if (c === 0x5c) out += '\\\\';  // \
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c < 0x20) {
      out += '\\u' + c.toString(16).padStart(4, '0');
    } else {
      out += s[i];
    }
  }
  return out;
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSha256Hex(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

// canonical JSON: sort keys alphabetically, produce compact {"a":"b","c":123,...}
// supports string, bool, null, int. For our payload all string/bool/int.
function jsonCanonical(obj) {
  const keys = Object.keys(obj).sort();
  let out = "{";
  let first = true;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    if (!first) out += ",";
    first = false;
    out += '"' + jsonEscape(k) + '":';
    if (typeof v === 'string') {
      out += '"' + jsonEscape(v) + '"';
    } else if (typeof v === 'boolean') {
      out += v ? "true" : "false";
    } else if (v === null) {
      out += "null";
    } else if (typeof v === 'number') {
      // int only in protocol
      out += Math.trunc(v).toString();
    } else {
      // fallback JSON stringify (should not happen)
      out += JSON.stringify(v);
    }
  }
  out += "}";
  return out;
}

function buildEnvelope(payloadObj, rid) {
  const pCanonical = jsonCanonical(payloadObj);
  const ph = sha256Hex(pCanonical);
  const t = Date.now().toString(); // ms timestamp, length 13 -> passes 10-40 check
  const n = crypto.randomBytes(8).toString('hex'); // 16 hex chars
  const canonical = `${ph}.${t}.${rid}.${n}`;
  const s = hmacSha256Hex(FACEGATE_HMAC_SECRET, canonical);
  return {
    envelope: { p: payloadObj, t, rid, n, s },
    pCanonical,
    ph
  };
}

// Helper to verify incoming? Not needed for server but included for completeness
function verifyEnvelope(jsonStr, sentRid) {
  try {
    const j = JSON.parse(jsonStr);
    const pRaw = j.p;
    const t = j.t;
    const rid = j.rid;
    const n = j.n;
    const s = j.s;
    if (!pRaw || !t || !rid || !n || !s) return null;
    if (rid !== sentRid) return null;
    if (t.length < 10 || t.length > 40) return null;
    const pCanonical = jsonCanonical(pRaw);
    const ph = sha256Hex(pCanonical);
    const canonical = `${ph}.${t}.${rid}.${n}`;
    const expected = hmacSha256Hex(FACEGATE_HMAC_SECRET, canonical);
    // constant time compare
    if (expected.length !== s.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ s.charCodeAt(i);
    if (diff !== 0) return null;
    return pCanonical; // validated
  } catch { return null; }
}

module.exports = { FACEGATE_HMAC_SECRET, jsonEscape, sha256Hex, hmacSha256Hex, jsonCanonical, buildEnvelope, verifyEnvelope };
