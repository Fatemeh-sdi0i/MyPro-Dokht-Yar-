// اعتبارسنجی پشتیبان سرور پیش از بازگردانی (ماژول خالص backend/src/backup-validate.js)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateBackup } = require("../backend/src/backup-validate");

const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const good = () => ({
  exported_at: "2026-11-24T06:00:00.000Z",
  shop: { shop_name: "مزون آزمون", owner_name: "مدیر", phone: "۰۹۱۲۳۴۵۶۷۸۹", address: "تهران", currency: "تومان" },
  customers: [
    { id: id(1), name: "علی", phone: "09121111111", note: "", tier: "vip", deleted_at: null },
    { id: id(2), name: "سارا", phone: null, note: "یادداشت", tier: "regular", deleted_at: "2026-11-10T10:00:00.000Z" },
  ],
  staff: [{ id: id(4), name: "زهرا", role_title: "خیاط", phone: "09125556677", active: true, deleted_at: null }],
  orders: [{
    id: id(5), order_no: 1, customer_id: id(1), customer: "علی", type: "sewing", description: "کت",
    status: "delivered", price: 900000, created_on: "2026-11-01", due_on: null, deleted_at: null,
  }],
  transactions: [{ id: id(6), kind: "income", category: "سایر", amount: 5, occurred_on: "2026-11-02", note: "", deleted_at: null }],
  status_log: [{ order_id: id(5), from_status: null, to_status: "delivered", changed_at: "2026-11-02T10:00:00.000Z" }],
});

function rejects(mutate, pattern) {
  const body = good();
  mutate(body);
  assert.throws(() => validateBackup(body), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, "invalid_backup");
    assert.match(err.message, pattern);
    return true;
  });
}

test("پشتیبان معتبر پذیرفته و نرمال می‌شود (شماره‌ی ایرانی، فاصله، حذف‌شده‌ها)", () => {
  const v = validateBackup(good());
  assert.equal(v.shop.phone, "09123456789");
  assert.equal(v.customers[0].phone, "09121111111");
  assert.equal(v.customers[1].phone, null);
  assert.equal(v.customers[1].deleted_at, "2026-11-10T10:00:00.000Z", "ردیف حذف‌شده نگه داشته می‌شود");
  assert.equal(v.orders[0].customer_id, id(1));
  assert.equal(v.statusLog.length, 1);
});

test("پشتیبان قدیمی بدون customer_id: با نام یکتای مشتری پذیرفته می‌شود", () => {
  const body = good();
  delete body.orders[0].customer_id;
  assert.equal(validateBackup(body).orders[0].customer_id, id(1));
});

test("رد: شماره‌ی تماس فعال تکراری", () => {
  rejects((b) => b.customers.push({ ...b.customers[0], id: id(7) }), /تکراری/);
});

test("رد: سفارش با مشتری خارج از فایل", () => {
  rejects((b) => { b.orders[0].customer_id = id(9); }, /مشتری این سفارش در فایل نیست/);
});

test("رد: قیمت منفی و اعشاری", () => {
  rejects((b) => { b.orders[0].price = -1; }, /«قیمت»/);
  rejects((b) => { b.orders[0].price = 10.5; }, /«قیمت»/);
});

test("رد: تاریخ نامعتبر و روز ناموجود", () => {
  rejects((b) => { b.transactions[0].occurred_on = "2026-13-40"; }, /تاریخ معتبر نیست/);
  rejects((b) => { b.orders[0].created_on = "2026-02-31"; }, /تاریخ معتبر نیست/);
});

test("رد: بخش مزون، فهرست‌های غلط و شناسه‌ی غیرمعتبر", () => {
  rejects((b) => { delete b.shop; }, /بخش مزون لازم است/);
  rejects((b) => { b.customers = "x"; }, /باید فهرست باشد/);
  rejects((b) => { b.customers[0].id = "not-a-uuid"; }, /شناسه‌ی معتبر نیست/);
  rejects((b) => { b.customers[0].name = "   "; }, /«نام» خالی است/);
});

test("رد: شماره‌ی سفارش تکراری و وضعیت ناشناخته", () => {
  rejects((b) => b.orders.push({ ...b.orders[0], id: id(8) }), /شماره‌ی سفارش» تکراری/);
  rejects((b) => { b.orders[0].status = "lost"; }, /مقدار «وضعیت» نامعتبر/);
});

test("رد: تاریخچه‌ی وضعیت که به سفارش فایل اشاره نمی‌کند", () => {
  rejects((b) => { b.status_log[0].order_id = id(9); }, /سفارش این تاریخچه در فایل نیست/);
});

test("خطا همه‌ی مشکلات را جمع می‌کند (نه فقط اولی)", () => {
  const body = good();
  body.orders[0].price = -1;
  body.transactions[0].amount = 0;
  assert.throws(() => validateBackup(body), (err) => /«قیمت»/.test(err.message) && /«مبلغ»/.test(err.message));
});

test("ورودی غیرشیء رد می‌شود", () => {
  assert.throws(() => validateBackup("متن"), /ساختار شناخته نشد/);
  assert.throws(() => validateBackup(null), /ساختار شناخته نشد/);
});
