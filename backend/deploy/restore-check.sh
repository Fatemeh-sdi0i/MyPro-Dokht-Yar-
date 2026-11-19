#!/usr/bin/env bash
# بازیابی آزمایشی یک پشتیبان در پایگاه داده‌ی جدا و مقایسه‌ی تعداد ردیف‌ها.
# این اسکریپت پایگاه داده‌ی اصلی را تغییر نمی‌دهد و باید دوره‌ای اجرا شود.
#
# استفاده:  ADMIN_URL=postgres://.../postgres BACKUP_FILE=... BACKUP_KEY_FILE=... ./restore-check.sh
set -euo pipefail

: "${ADMIN_URL:?ADMIN_URL (اتصال به پایگاه postgres) لازم است}"
: "${BACKUP_FILE:?BACKUP_FILE لازم است}"
: "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE لازم است}"

DB="dokhtyar_restore_check"
BASE="${ADMIN_URL%/*}"
TARGET="$BASE/$DB"

psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
trap 'psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DB" >/dev/null' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$BACKUP_FILE" \
  | gunzip \
  | psql "$TARGET" -v ON_ERROR_STOP=1 -q

psql "$TARGET" -tAc "SELECT 'orders=' || count(*) FROM orders UNION ALL SELECT 'customers=' || count(*) FROM customers" 
echo "بازیابی آزمایشی انجام شد؛ پایگاه داده‌ی موقت حذف شد."
