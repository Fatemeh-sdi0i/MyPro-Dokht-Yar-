-- دوخت‌یار — مهاجرت ۰۰۱: طرح اولیه‌ی دیتابیس
-- قواعد کلی:
--   * کلید اصلی uuid؛ زمان‌ها timestamptz (میلادی)؛ تاریخ‌های روزانه از نوع date
--   * مبالغ به تومان و عدد صحیح (bigint)
--   * حذف نرم با deleted_at؛ version برای تشخیص تعارض همگام‌سازی

BEGIN;

-- ---------- انواع شمارشی ----------
CREATE TYPE user_role       AS ENUM ('admin', 'staff');
CREATE TYPE customer_tier   AS ENUM ('regular', 'active', 'vip');
CREATE TYPE order_type      AS ENUM ('sewing', 'repair');
CREATE TYPE order_status    AS ENUM ('waiting', 'progress', 'ready', 'delivered');
CREATE TYPE transaction_kind AS ENUM ('income', 'expense');

-- ---------- تابع مشترک: به‌روزرسانی updated_at و افزایش version ----------
CREATE FUNCTION touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END;
$$;

-- ---------- مزون (فعلاً یک ردیف) ----------
CREATE TABLE shops (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  owner_name  text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '' CHECK (phone = '' OR phone ~ '^09[0-9]{9}$'),
  address     text NOT NULL DEFAULT '',
  currency    text NOT NULL DEFAULT 'تومان',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE TRIGGER shops_touch BEFORE UPDATE ON shops FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------- کاربران (فعلاً فقط مدیر) ----------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  email         text NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  role          user_role NOT NULL DEFAULT 'admin',
  disabled_at   timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------- نشست‌ها (قابل ابطال) ----------
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,          -- هش توکن؛ خود توکن ذخیره نمی‌شود
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------- مشتریان ----------
CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  phone       text CHECK (phone IS NULL OR phone ~ '^09[0-9]{9}$'),
  note        text NOT NULL DEFAULT '',
  tier        customer_tier NOT NULL DEFAULT 'regular',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1
);
-- شماره‌ی تماس در هر مزون یکتا است (فقط برای رکوردهای فعال)
CREATE UNIQUE INDEX customers_phone_key ON customers (shop_id, phone)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX customers_name_idx ON customers (shop_id, name);
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------- همکاران ----------
CREATE TABLE staff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id     uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  role_title  text NOT NULL DEFAULT '',
  phone       text CHECK (phone IS NULL OR phone ~ '^09[0-9]{9}$'),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1
);
CREATE TRIGGER staff_touch BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------- سفارش‌ها ----------
CREATE TABLE orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  order_no    integer NOT NULL CHECK (order_no > 0),   -- شماره‌ی قابل‌خواندن برای مشتری
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  type        order_type NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  status      order_status NOT NULL DEFAULT 'waiting',
  price       bigint NOT NULL DEFAULT 0 CHECK (price >= 0),
  created_on  date NOT NULL DEFAULT current_date,
  due_on      date,                                     -- NULL = تعیین‌نشده
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (shop_id, order_no)
);
CREATE INDEX orders_status_idx ON orders (shop_id, status) WHERE deleted_at IS NULL;
CREATE INDEX orders_due_idx    ON orders (shop_id, due_on)  WHERE deleted_at IS NULL;
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------- تاریخچه‌ی تغییر وضعیت سفارش ----------
CREATE TABLE order_status_log (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status order_status,
  to_status   order_status NOT NULL,
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_log_order_idx ON order_status_log (order_id, changed_at);

-- ---------- امور مالی ----------
CREATE TABLE transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind        transaction_kind NOT NULL,
  category    text NOT NULL CHECK (length(btrim(category)) > 0),
  amount      bigint NOT NULL CHECK (amount > 0),
  occurred_on date NOT NULL DEFAULT current_date,
  note        text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1
);
CREATE INDEX transactions_shop_idx ON transactions (shop_id, occurred_on) WHERE deleted_at IS NULL;
CREATE TRIGGER transactions_touch BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION touch_row();

COMMIT;
