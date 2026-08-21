# DocsEditor — VPS deployment

This repo is also Render-ready (`render.yaml`), but for a VPS + custom domain
this is the playbook. Everything lives in this folder:

| File | Purpose |
|---|---|
| `setup.sh` | One-shot server provisioning: Node 22, fonts, app checkout, PM2, nginx, Let's Encrypt |
| `ecosystem.config.js` | PM2 process file (secrets loaded from `<app>/.env` via `--env-file`) |
| `nginx-docseditor.conf` | Reverse proxy site config (HTTP; certbot upgrades it to HTTPS) |
| `.env.example` | Environment template — copy to `<app>/.env` on the server |

## 1. DNS (do this at your registrar)

Create these records exactly — don't reuse the old VPS/Nginx records from a
previous host:

| Type | Host | Value |
|---|---|---|
| A | `@` | your VPS public IP |
| A | `www` | your VPS public IP |

(Or a CNAME for `www` → your apex domain if the registrar prefers it.)
Allow 5–60 minutes for propagation; HTTPS needs the records live.

## 2. Provision the server

On the VPS as root (Ubuntu 22.04/24.04):

```bash
curl -fsSL -o /tmp/ds-setup.sh https://raw.githubusercontent.com/hawoosad-art/docseditor/main/deploy/setup.sh
bash /tmp/ds-setup.sh yourdomain.com
```

Or if you clone the repo manually: `bash deploy/setup.sh yourdomain.com`.
The script is idempotent — re-running it re-syncs the repo and re-writes the
nginx config safely.

## 3. Fill in secrets

```bash
nano /opt/docseditor/.env      # set ADMIN_USER / ADMIN_PASS (+ anything else)
pm2 restart docseditor
```

`SESSION_SECRET` is auto-generated for you. The `.env` is git-ignored and
chmod 600 on the server.

## 4. Verify

```bash
curl -s https://yourdomain.com/api/health   # {"ok":true,...}
pm2 logs docseditor --lines 30
```

Open `https://yourdomain.com/card-designer` and sign in with the admin
credentials — the card designer, template, and coordinate overlay should all
work exactly like the local preview.

## Updating the app later

```bash
cd /opt/docseditor
git pull
npm ci --omit=dev
pm2 restart docseditor
```

## Notes

- **Firewall:** if `ufw` is enabled: `ufw allow 22,80,443/tcp`.
- **Data:** the only persistent state is `uploads/` (APKs, PSDs, generated
  cards) and `data/` (license DB). Back these up; everything else is code.
- **Card rendering:** needs `fonts-dejavu-core` (installed by the script) —
  sharp/librsvg renders card text with it.
- **Rate limits:** `TRUST_PROXY=1` is set in production so the app's rate
  limiters see real client IPs through nginx.
