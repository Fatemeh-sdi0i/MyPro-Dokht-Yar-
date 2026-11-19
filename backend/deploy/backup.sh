#!/usr/bin/env bash
# پشتیبان‌گیری روزانه از PostgreSQL: فشرده‌سازی و رمزنگاری AES-256 با کلید در فایل جداگانه.
# پشتیبان بدون رمزنگاری ساخته نمی‌شود. کلید را جدا از پشتیبان‌ها و خارج از مخزن نگه دارید.
#
# استفاده (با cron یا systemd timer):
#   DATABASE_URL=postgres://... BACKUP_KEY_FILE=/etc/dokhtyar/backup.key ./backend/deploy/backup.sh
#
# متغیرهای اختیاری: BACKUP_DIR (پیش‌فرض /var/backups/dokhtyar)، BACKUP_RETAIN_DAYS (پیش‌فرض ۱۴)
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL لازم است}"
: "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE لازم است؛ بدون کلید پشتیبان ساخته نمی‌شود}"
[ -s "$BACKUP_KEY_FILE" ] || { echo "فایل کلید خالی یا پیدا نشد: $BACKUP_KEY_FILE"; exit 1; }

DEST="${BACKUP_DIR:-/var/backups/dokhtyar}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

mkdir -p "$DEST"
chmod 700 "$DEST"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/dokhtyar-$STAMP.sql.gz.enc"
TMP="$OUT.partial"

# اگر pg_dump یا هر مرحله‌ی لوله‌کشی خطا بدهد، فایل ناقص منتشر نمی‌شود
pg_dump --no-owner --no-privileges "$DATABASE_URL" \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_KEY_FILE" -out "$TMP"

[ -s "$TMP" ] || { echo "پشتیبان خالی ساخته شد؛ متوقف شد"; rm -f "$TMP"; exit 1; }
mv "$TMP" "$OUT"
chmod 600 "$OUT"

find "$DEST" -maxdepth 1 -name 'dokhtyar-*.sql.gz.enc' -mtime +"$RETAIN_DAYS" -delete

echo "پشتیبان ساخته شد: $OUT"
