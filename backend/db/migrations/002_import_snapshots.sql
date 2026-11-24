-- دوخت‌یار — مهاجرت ۰۰۲: نسخه‌ی پیش از بازگردانی (snapshot) سمت سرور
-- هر بازگردانی سرور، پیش از جایگزینی، کل داده‌ی مزون را (شامل ردیف‌های حذف‌نرم‌شده و تاریخچه‌ی وضعیت سفارش) اینجا ذخیره می‌کند.
-- payload همان شکل پاسخ GET /export به‌علاوه‌ی status_log است؛ با همان POST /import/replace قابل بازگردانی است.

BEGIN;

CREATE TABLE shop_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  reason      text NOT NULL CHECK (length(btrim(reason)) > 0),
  payload     jsonb NOT NULL
);
CREATE INDEX shop_snapshots_shop_idx ON shop_snapshots (shop_id, created_at DESC);

COMMIT;
