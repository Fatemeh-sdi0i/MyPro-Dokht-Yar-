#!/usr/bin/env bash
# آزمون طرح دیتابیس: مهاجرت‌ها را روی یک پایگاه موقت اجرا و قواعد یکپارچگی را بررسی می‌کند.
# استفاده: ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres ./backend/db/test/schema_test.sh
set -uo pipefail

ADMIN_URL="${ADMIN_URL:?ADMIN_URL لازم است}"
DB="dokhtyar_test_$$"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TEST_URL="${ADMIN_URL%/*}/$DB"

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ✔ $1"; }
bad()  { fail=$((fail+1)); echo "  ✘ $1"; }

psql "$ADMIN_URL" -qtAc "CREATE DATABASE $DB" >/dev/null
trap 'psql "$ADMIN_URL" -qtAc "DROP DATABASE IF EXISTS $DB" >/dev/null' EXIT
DATABASE_URL="$TEST_URL" "$ROOT/backend/db/migrate.sh" >/dev/null || { echo "مهاجرت شکست خورد"; exit 1; }

q()  { psql "$TEST_URL" -v ON_ERROR_STOP=1 -qtAc "$1" 2>/dev/null; }
# expect_fail "توضیح" "SQL"  → باید خطا بدهد
expect_fail() { if q "$2" >/dev/null; then bad "$1 (باید رد می‌شد)"; else ok "$1"; fi; }
# expect_ok "توضیح" "SQL"  → باید موفق باشد
expect_ok()   { if q "$2" >/dev/null; then ok "$1"; else bad "$1 (باید می‌پذیرفت)"; fi; }
expect_eq()   { local got; got=$(q "$2"); if [ "$got" = "$3" ]; then ok "$1"; else bad "$1 (گرفته: $got، انتظار: $3)"; fi; }

echo "طرح پایه:"
SHOP=$(q "INSERT INTO shops (name) VALUES ('مزون تست') RETURNING id")
expect_fail "شماره‌ی تماس نادرست در مشتری رد شود" \
  "INSERT INTO customers (shop_id,name,phone) VALUES ('$SHOP','الف','0912')"
expect_ok "مشتری با شماره‌ی درست پذیرفته شود" \
  "INSERT INTO customers (shop_id,name,phone) VALUES ('$SHOP','مریم','09123456789')"
expect_fail "شماره‌ی تکراری فعال در همان مزون رد شود" \
  "INSERT INTO customers (shop_id,name,phone) VALUES ('$SHOP','دوم','09123456789')"
expect_ok "مشتری بدون شماره مجاز است" \
  "INSERT INTO customers (shop_id,name) VALUES ('$SHOP','بی‌شماره')"
expect_ok "بعد از حذف نرم، همان شماره دوباره قابل ثبت است" \
  "UPDATE customers SET deleted_at=now() WHERE phone='09123456789' AND shop_id='$SHOP'"
expect_ok "ثبت مجدد شماره بعد از حذف نرم" \
  "INSERT INTO customers (shop_id,name,phone) VALUES ('$SHOP','سوم','09123456789')"

echo "سفارش‌ها و وضعیت:"
CUST=$(q "SELECT id FROM customers WHERE name='سوم'")
expect_ok "سفارش معتبر" \
  "INSERT INTO orders (shop_id,order_no,customer_id,type,description,price) VALUES ('$SHOP',1,'$CUST','sewing','مانتو',6200000)"
expect_fail "شماره‌ی سفارش تکراری در مزون رد شود" \
  "INSERT INTO orders (shop_id,order_no,customer_id,type,description) VALUES ('$SHOP',1,'$CUST','sewing','تکراری')"
expect_fail "وضعیت ناشناخته رد شود" \
  "INSERT INTO orders (shop_id,order_no,customer_id,type,description,status) VALUES ('$SHOP',2,'$CUST','sewing','x','lost')"
expect_fail "نوع سفارش ناشناخته رد شود" \
  "INSERT INTO orders (shop_id,order_no,customer_id,type,description) VALUES ('$SHOP',3,'$CUST','knitting','x')"
expect_fail "قیمت منفی رد شود" \
  "INSERT INTO orders (shop_id,order_no,customer_id,type,description,price) VALUES ('$SHOP',4,'$CUST','repair','x',-1)"
expect_fail "سفارش بدون توضیح رد شود" \
  "INSERT INTO orders (shop_id,order_no,customer_id,type,description) VALUES ('$SHOP',5,'$CUST','repair','   ')"
expect_fail "حذف مشتری دارای سفارش ممنوع است" \
  "DELETE FROM customers WHERE id='$CUST'"
expect_ok "تحویل بدون تاریخ تحویل (NULL) مجاز است" \
  "INSERT INTO orders (shop_id,order_no,customer_id,type,description) VALUES ('$SHOP',6,'$CUST','repair','بدون مهلت')"

echo "نسخه و زمان‌ها:"
VER_BEFORE=$(q "SELECT version FROM orders WHERE order_no=1")
expect_ok "به‌روزرسانی سفارش" "UPDATE orders SET status='progress' WHERE order_no=1"
expect_eq "version بعد از به‌روزرسانی یکی زیاد شود" \
  "SELECT version FROM orders WHERE order_no=1" "$((VER_BEFORE+1))"
expect_eq "updated_at جلو برود" \
  "SELECT (updated_at >= created_at)::text FROM orders WHERE order_no=1" "true"

echo "امور مالی و کاربران:"
expect_fail "تراکنش با مبلغ صفر رد شود" \
  "INSERT INTO transactions (shop_id,kind,category,amount) VALUES ('$SHOP','expense','پارچه',0)"
expect_fail "نوع تراکنش ناشناخته رد شود" \
  "INSERT INTO transactions (shop_id,kind,category,amount) VALUES ('$SHOP','gift','x',10)"
expect_ok "تراکنش معتبر" \
  "INSERT INTO transactions (shop_id,kind,category,amount,note) VALUES ('$SHOP','expense','اجاره',3000000,'تست')"
expect_fail "ایمیل با حروف بزرگ رد شود (باید با lower-case ذخیره شود)" \
  "INSERT INTO users (shop_id,email,password_hash,full_name) VALUES ('$SHOP','Admin@x.com','h','مدیر')"
expect_ok "کاربر مدیر" \
  "INSERT INTO users (shop_id,email,password_hash,full_name) VALUES ('$SHOP','admin@x.com','h','مدیر')"
expect_fail "ایمیل تکراری رد شود" \
  "INSERT INTO users (shop_id,email,password_hash,full_name) VALUES ('$SHOP','admin@x.com','h','تکراری')"
expect_fail "نشست بدون انقضا رد شود" \
  "INSERT INTO sessions (user_id,token_hash,expires_at) VALUES ((SELECT id FROM users LIMIT 1),'h1',NULL)"
expect_ok "حذف مزون، داده‌های وابسته را پاک می‌کند" \
  "DELETE FROM shops WHERE id='$SHOP'"
expect_eq "پس از حذف مزون، مشتری‌ای نمانده" "SELECT count(*) FROM customers" "0"

echo ""
echo "نتیجه: $pass موفق، $fail ناموفق"
[ "$fail" -eq 0 ]
