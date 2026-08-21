/**
 * Regenerates the single base card template: templates/base-card.png
 *
 * The design is drawn as an SVG and rasterised with sharp. Field LABELS are
 * derived from card-config.json so the template and the composer can never
 * drift apart: change the coordinate map, re-run this script, done.
 *
 *   node scripts/make-base-template.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../card-config.json');

const { canvas: C, photo: PHOTO, fields: F } = config;
const FONT = "'DejaVu Sans', 'Liberation Sans', 'Noto Sans', Arial, sans-serif";

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Baked-in label for a field: sits just above the dynamic value baseline. */
function label(fieldKey, text) {
  const f = F[fieldKey];
  const y = f.y - f.fontSize * 0.82 - 12;
  return `<text x="${f.x}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="19" font-weight="600" fill="#7f8db0" letter-spacing="3">${text}</text>`;
}

/** Placeholder silhouette shown inside the photo slot until a photo is merged. */
function photoPlaceholder() {
  const cx = PHOTO.x + PHOTO.width / 2;
  const headR = 26;
  const headCy = PHOTO.y + 82;
  const bodyCy = PHOTO.y + 158;
  return `
    <circle cx="${cx}" cy="${headCy}" r="${headR}" fill="none" stroke="#7f8db0" stroke-width="4"/>
    <path d="M ${cx - 52} ${bodyCy + 40} A 52 52 0 0 1 ${cx + 52} ${bodyCy + 40} Z" fill="none" stroke="#7f8db0" stroke-width="4"/>
    <text x="${cx}" y="${PHOTO.y + PHOTO.height - 26}" font-family="${FONT}" font-size="20" font-weight="600" fill="#7f8db0" text-anchor="middle" letter-spacing="4">PHOTO</text>`;
}

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${C.width}" height="${C.height}" viewBox="0 0 ${C.width} ${C.height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#10142a"/>
      <stop offset="1" stop-color="#1c2446"/>
    </linearGradient>
  </defs>

  <!-- background -->
  <rect width="${C.width}" height="${C.height}" fill="url(#bg)"/>
  <rect x="0" y="0" width="10" height="${C.height}" fill="#39d0b4"/>
  <circle cx="1020" cy="80" r="260" fill="#39d0b4" opacity="0.05"/>
  <circle cx="60" cy="640" r="200" fill="#39d0b4" opacity="0.05"/>
  <path d="M 560 0 L 1050 330 L 1050 420 L 560 90 Z" fill="#ffffff" opacity="0.02"/>

  <!-- header: wordmark + card type pill -->
  <text x="88" y="76" font-family="${FONT}" font-size="46" font-weight="700" fill="#ffffff">DOCSEDITOR</text>
  <text x="88" y="106" font-family="${FONT}" font-size="20" font-weight="600" fill="#39d0b4" letter-spacing="5">DEMO CARD STUDIO</text>
  <rect x="700" y="38" width="262" height="44" rx="22" fill="none" stroke="#39d0b4" stroke-width="2"/>
  <text x="831" y="66" font-family="${FONT}" font-size="19" font-weight="700" fill="#39d0b4" text-anchor="middle" letter-spacing="2">MEMBERSHIP CARD</text>
  <line x1="88" y1="128" x2="962" y2="128" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>

  <!-- photo slot -->
  <rect x="${PHOTO.x}" y="${PHOTO.y}" width="${PHOTO.width}" height="${PHOTO.height}" rx="${PHOTO.radius}" fill="#ffffff" fill-opacity="0.05" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>
  ${photoPlaceholder()}

  <!-- field labels (values are overlaid dynamically by card-composer.js) -->
  ${label('name', 'NAME')}
  ${label('dob', 'DATE OF BIRTH')}
  ${label('expiry', 'EXPIRY')}
  ${label('role', 'ROLE')}
  ${label('memberId', 'MEMBER ID')}

  <!-- bottom-left footer sits above the composer's watermark banner -->
  <text x="88" y="640" font-family="${FONT}" font-size="16" font-weight="500" fill="#5a6a94" letter-spacing="2">DOCSEDITOR • DEMO CARD STUDIO</text>
</svg>`;

const outPath = path.join(__dirname, '..', config.template);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

sharp(Buffer.from(svg))
  .png()
  .toFile(outPath)
  .then((info) => console.log(`template written: ${outPath} (${info.width}x${info.height})`))
  .catch((err) => {
    console.error('template generation failed:', err.message);
    process.exit(1);
  });
