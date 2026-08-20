# DocsEditor

DocsEditor is the Render-ready version of the FaceGate PSD editor and safe fictional demo-card workflow. It includes the public pages, license API, PSD editor, protected admin panel, direct APK download routes, and the safe AI-assisted demo-card endpoint.

## Run locally

    npm ci
    ADMIN_USER=admin ADMIN_PASS='choose-a-password' OPENAI_API_KEY='...' npm start

Open /editor for the PSD editor. Admin login is at the public home page; after login, the APK Build panel includes an upload control. Uploaded files are available at /files/FaceGate.apk.

## Render

The included render.yaml uses npm ci, npm start, and /api/health. Add the secret environment variables in Render before going live.

Render free instances have ephemeral filesystems. APKs uploaded through the admin panel can disappear after a restart or redeploy. For reliable distribution, commit a release APK into durable static/release storage or attach persistent/external object storage before relying on the upload panel.

## Domain

In Render, add the custom domain and copy the DNS records Render provides. At the registrar, create those records exactly; do not use the old VPS/Nginx records.

The demo-card workflow permanently stamps SAMPLE — NOT A REAL ID and is restricted to fictional, non-official profile cards.
