#!/usr/bin/env bash
# اجرای مهاجرت‌ها به ترتیب شماره؛ هر فایل فقط یک بار و در یک تراکنش اجرا می‌شود.
# استفاده: DATABASE_URL=postgres://... ./backend/db/migrate.sh
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL لازم است}"
DIR="$(cd "$(dirname "$0")" && pwd)/migrations"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );"

for file in "$DIR"/*.sql; do
  name="$(basename "$file")"
  applied=$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM schema_migrations WHERE name = '$name'")
  if [ "$applied" = "1" ]; then
    echo "skip   $name"
    continue
  fi
  echo "apply  $name"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$file"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO schema_migrations (name) VALUES ('$name');"
done
echo "done"
