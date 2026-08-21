#!/usr/bin/env bash
# DocsEditor VPS setup — Ubuntu 22.04/24.04, run as root.
#
#   bash deploy/setup.sh yourdomain.com [/opt/docseditor]
#
# Idempotent: safe to re-run after DNS/provisioning changes (it re-syncs the
# repo, re-installs what's missing, and re-writes the nginx site).
set -euo pipefail

DOMAIN="${1:?usage: $0 <your-domain.com> [app-dir]}"
APP_DIR="${2:-/opt/docseditor}"
REPO="https://github.com/hawoosad-art/docseditor.git"

echo "==> 1/8 base packages"
apt-get update -y
apt-get install -y git curl ca-certificates gnupg nginx

echo "==> 2/8 Node.js 22 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | tr -d v | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> 3/8 fonts (sharp/librsvg text rendering needs DejaVu)"
apt-get install -y fonts-dejavu-core fontconfig

echo "==> 4/8 app checkout"
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin && git -C "$APP_DIR" reset --hard origin/main
else
  git clone "$REPO" "$APP_DIR"
fi

echo "==> 5/8 dependencies + environment file"
cd "$APP_DIR"
npm ci --omit=dev
if [ ! -f .env ]; then
  cp deploy/.env.example .env
  { echo "# auto-generated $(date -u +%FT%TZ)"; echo "SESSION_SECRET=$(openssl rand -hex 32)"; } >> .env
  chmod 600 .env
  echo "!! created $APP_DIR/.env — set ADMIN_USER / ADMIN_PASS (and any other secrets) now, then: pm2 restart docseditor"
fi

echo "==> 6/8 PM2 process manager"
mkdir -p logs
npm install -g pm2
pm2 start deploy/ecosystem.config.js || pm2 restart docseditor
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null || true

echo "==> 7/8 nginx site"
sed "s/YOUR_DOMAIN/$DOMAIN/g" deploy/nginx-docseditor.conf > /etc/nginx/sites-available/docseditor.conf
ln -sf /etc/nginx/sites-available/docseditor.conf /etc/nginx/sites-enabled/docseditor.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> 8/8 HTTPS (Let's Encrypt)"
apt-get install -y certbot python3-certbot-nginx
mkdir -p /var/www/certbot
if certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --redirect -m "admin@$DOMAIN"; then
  systemctl reload nginx
else
  echo "!! certbot skipped — make sure DNS for $DOMAIN already points at this server, then rerun:"
  echo "   certbot --nginx -d $DOMAIN -d www.$DOMAIN"
fi

echo
echo "──────────────────────────────────────────────────────────"
echo " Done."
echo "   Health:        https://$DOMAIN/api/health"
echo "   Card designer: https://$DOMAIN/card-designer"
echo "   Admin:         https://$DOMAIN (FaceGate admin panel)"
echo "   Logs:          pm2 logs docseditor"
echo "──────────────────────────────────────────────────────────"
