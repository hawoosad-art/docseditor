# DocsEditor

DocsEditor is the Render-ready version of the FaceGate PSD editor and safe fictional demo-card workflow. It includes the public pages, license API, PSD editor, protected admin panel, direct APK download routes, and the safe AI-assisted demo-card endpoint.

## Run locally

    npm ci
    ADMIN_USER=admin ADMIN_PASS='choose-a-password' OPENAI_API_KEY='...' npm start

Open /editor for the template studio (PSD or PNG/JPEG, front + back, Google fonts, placeholder chips, undo/zoom, look presets, and Studio AI Copilot via `POST /api/studio/ai`). Admin login is at the public home page; after login, the APK Build panel includes an upload control. Uploaded files are available at /files/FaceGate.apk.

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

Admin-only card composer at `/card-designer` (sign in with the admin credentials first). `POST /api/cards/generate` accepts multipart fields (`name`, `dob` DD/MM/YYYY, `expiry` MM/YYYY, `role`, optional `memberId`) plus a `photo` file (JPEG/PNG/WebP, max 8 MB) and merges them onto the active template at the configured coordinates.

- **Upload your organization's template** — `POST /api/cards/template` (admin, PNG/JPEG/WebP up to 15 MB). The generated PNG is exactly this template; the starter template is only the fallback. The upload UI seeds a proportionally-scaled version of the default coordinate map.
- **Coordinate editor** — on the designer page, switch on "Edit coordinates", drag the photo box and each text field onto their slots (or type exact pixel values), then "Save layout" (`PUT /api/cards/layout`). "Reset coordinates" / "Back to starter" restore defaults.
- **AI: read template** — `POST /api/cards/analyze-template` (admin). A vision model (needs `OPENAI_API_KEY`, model `OPENAI_VISION_MODEL`) reads the active template, finds the photo slot and every field's value area next to its printed label, and saves the layout automatically — no matter where the placeholders sit on the design. Boxes can still be fine-tuned by dragging afterwards.
- **AI proofreading** — before printing, a text model reviews the entered fields and fixes only unambiguous typos (e.g. "Julit" → "Juliet"); dates and IDs are never touched. Applied fixes are returned as `corrections` in the generate response and shown in the UI. Opt out per request (`aiCorrect=false`) or globally (`CARD_AI_CORRECT=0`).
- Without a key everything still works manually: layout via drag-and-drop, no correction pass. `card-ai.js` degrades gracefully (`AI_UNAVAILABLE` on the analyze endpoint).
- `card-config.json` — default coordinate map (photo slot + per-field baselines: X/Y/maxWidth/fontSize/color). Coordinates that fall outside the canvas are rejected with `COORDINATE_OVERFLOW` (422).
- `scripts/make-base-template.js` — regenerates the bundled starter template (`templates/base-card.png`); labels are derived from `card-config.json`.
- `card-composer.js` — pure `sharp` composition service (validation, photo cover-fit + rounded corners, SVG text overlay). No external APIs or keys involved.
- `card-routes.js` — Express router: `/generate`, `/template`, `/layout`, `/template-preview`, `/:id/preview`, `/:id/download`. Multer memory storage (raw photos are never written to disk), per-IP rate limiting, admin-gated.
- Custom template + layout persist in `uploads/templates/` (git-ignored, survives deploys). Generated cards live in `uploads/cards/` and are pruned to the newest 200.

Note: text is rendered via librsvg/pango, so the host needs a DejaVu-class sans-serif font (`sudo apt install fonts-dejavu-core` on bare VPS images).
