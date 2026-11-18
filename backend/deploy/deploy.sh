#!/usr/bin/env bash
# استقرار دوخت‌یار روی یک سرور لینوکسی (بدون هزینه‌ی اضافه؛ فقط ابزارهای متن‌باز).
# پیش‌نیاز: git، Node.js 20+، PostgreSQL، psql، systemd.
# فایل محیطی /etc/dokhtyar/env شامل DATABASE_URL، HOST، PORT، TRUST_PROXY=1، NODE_ENV=production.
#
# استفاده (روی سرور):  sudo DOKHTYAR_DIR=/opt/dokhtyar ./deploy.sh
set -euo pipefail

DIR="${DOKHTYAR_DIR:-/opt/dokhtyar}"
ENV_FILE="${DOKHTYAR_ENV:-/etc/dokhtyar/env}"
SERVICE="${DOKHTYAR_SERVICE:-dokhtyar}"
PORT_CHECK="${DOKHTYAR_HEALTH_URL:-http://127.0.0.1:3000/api/v1/healthz}"

log() { printf '\n==> %s\n' "$*"; }

[ -f "$ENV_FILE" ] || { echo "فایل محیطی $ENV_FILE پیدا نشد"; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${DATABASE_URL:?DATABASE_URL در $ENV_FILE تنظیم نشده است}"

log "به‌روزرسانی کد (فقط fast-forward)"
git -C "$DIR" fetch --quiet origin
git -C "$DIR" merge --ff-only origin/main

log "نصب وابستگی‌های تولید"
cd "$DIR/backend"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

log "اعمال مهاجرت‌های پایگاه داده"
"$DIR/backend/db/migrate.sh"

log "راه‌اندازی مجدد سرویس"
systemctl restart "$SERVICE"

log "بررسی سلامت"
for _ in $(seq 1 20); do
  if curl -fsS "$PORT_CHECK" >/dev/null 2>&1; then
    echo "سرویس بالا آمد."
    exit 0
  fi
  sleep 1
done
echo "سرویس پاسخ نداد. گزارش: journalctl -u $SERVICE -n 100"
exit 1
