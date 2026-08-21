# DocsEditor

DocsEditor is the Render-ready version of the FaceGate PSD editor and safe fictional demo-card workflow. It includes the public pages, license API, PSD editor, protected admin panel, direct APK download routes, and the safe AI-assisted demo-card endpoint.

## Run locally

    npm ci
    ADMIN_USER=admin ADMIN_PASS='choose-a-password' OPENAI_API_KEY='...' npm start

Open /editor for the PSD editor. Admin login is at the public home page; after login, the APK Build panel includes an upload control. Uploaded files are available at /files/FaceGate.apk.

## VPS deployment

Full playbook (DNS records, provisioning script, nginx + PM2 + Let's Encrypt) in [deploy/README.md](deploy/README.md):

    bash deploy/setup.sh yourdomain.com

## Render

The included render.yaml uses npm ci, npm start, and /api/health. Add the secret environment variables in Render before going live.

Render free instances have ephemeral filesystems. APKs uploaded through the admin panel can disappear after a restart or redeploy. For reliable distribution, commit a release APK into durable static/release storage or attach persistent/external object storage before relying on the upload panel.

## Domain

In Render, add the custom domain and copy the DNS records Render provides. At the registrar, create those records exactly; do not use the old VPS/Nginx records.

The demo-card workflow permanently stamps SAMPLE — NOT A REAL ID and is restricted to fictional, non-official profile cards.

## Card designer (DocsEditor)

Admin-only card composer at `/card-designer` (sign in with the admin credentials first). `POST /api/cards/generate` accepts multipart fields (`name`, `dob` DD/MM/YYYY, `expiry` MM/YYYY, `role`, optional `memberId`) plus a `photo` file (JPEG/PNG/WebP, max 8 MB) and merges them onto the single base template.

- `card-config.json` — coordinate map: photo slot + per-field baselines (X/Y/maxWidth/fontSize/color). Any coordinate that falls outside the canvas is rejected with `COORDINATE_OVERFLOW` (422).
- `scripts/make-base-template.js` — regenerates `templates/base-card.png`; field labels are derived from `card-config.json` so template and composer stay in sync. Run it after editing coordinates.
- `card-composer.js` — pure `sharp` composition service (validation, photo cover-fit + rounded corners, SVG text overlay, watermark). No external APIs or keys involved.
- `card-routes.js` — Express router: `/generate`, `/layout`, `/template-preview`, `/:id/preview`, `/:id/download`. Multer memory storage (raw photos are never written to disk), per-IP rate limiting, admin-gated.
- Uploaded outputs live in `uploads/cards/` (git-ignored) and are pruned to the newest 200.

Every generated card is permanently stamped **SAMPLE — NOT AN OFFICIAL DOCUMENT** (amber bottom banner + tiled diagonal watermark) — this layer is mandatory by design and is not config-removable.

Note: text is rendered via librsvg/pango, so the host needs a DejaVu-class sans-serif font (`sudo apt install fonts-dejavu-core` on bare VPS images).
