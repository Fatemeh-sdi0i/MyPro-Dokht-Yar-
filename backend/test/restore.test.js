// آزمون‌های بازگردانی کامل از پشتیبان سرور (POST /import/replace) روی PostgreSQL واقعی.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');
const { buildApp } = require('../src/app');
const { createShopAdmin } = require('../scripts/create-admin');
const { hashPassword } = require('../src/auth');
const { replaceShopData } = require('../src/restore');

const URL = process.env.DATABASE_URL || '';
if (!/test/.test(URL)) throw new Error('DATABASE_URL باید به یک پایگاه تست اشاره کند');

const PASSWORD = 'گذرواژه‌ی-آزمایشی-۱۲۳';
let db, app, cookie, staffCookie, shopId, adminId;

const call = (method, url, payload, c = cookie) =>
  app.inject({ method, url, payload, headers: c ? { cookie: c } : {} });

async function login(email) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return res.headers['set-cookie'].split(';')[0];
}

// وضعیت مزون بدون زمان تولید فایل، برای مقایسه‌ی دقیق
async function state() {
  const body = (await call('GET', '/api/v1/export')).json();
  const { exported_at, ...rest } = body;
  return rest;
}

before(async () => {
  db = createPool(URL);
  app = buildApp({ db, loginMax: 1000 });
  await app.ready();
  await db.query('TRUNCATE shops, users, sessions, customers, staff, orders, order_status_log, transactions, shop_snapshots CASCADE');
  const made = await createShopAdmin(db, { shopName: 'مزون بازگردانی', email: 'admin@restore.dev', password: PASSWORD, fullName: 'مدیر' });
  shopId = made.shopId;
  adminId = (await db.query('SELECT id FROM users WHERE email = $1', ['admin@restore.dev'])).rows[0].id;
  await db.query(
    `INSERT INTO users (shop_id, email, password_hash, full_name, role) VALUES ($1, 'staff@restore.dev', $2, 'خیاط', 'staff')`,
    [shopId, await hashPassword(PASSWORD)]
  );
  cookie = await login('admin@restore.dev');
  staffCookie = await login('staff@restore.dev');

  // داده‌ی اولیه: دو مشتری (یکی حذف‌شده)، سفارش با تاریخچه، همکار، تراکنش‌ها (یکی حذف‌شده)
  const c1 = (await call('POST', '/api/v1/customers', { name: 'علی', phone: '09121111111' })).json();
  const c2 = (await call('POST', '/api/v1/customers', { name: 'سارا', phone: '09122222222', note: 'یادداشت' })).json();
  const o1 = (await call('POST', '/api/v1/orders', { customer_id: c1.id, type: 'sewing', description: 'کت', price: 900000, due_on: '2026-12-01' })).json();
  await call('POST', `/api/v1/orders/${o1.id}/status`, { to: 'progress', version: o1.version });
  await call('POST', '/api/v1/orders', { customer_id: c2.id, type: 'repair', description: 'زیپ', price: 50000 });
  await call('POST', '/api/v1/staff', { name: 'زهرا', role_title: 'خیاط', phone: '09125556677' });
  const t1 = (await call('POST', '/api/v1/transactions', { kind: 'expense', category: 'پارچه', amount: 300000, occurred_on: '2026-11-02' })).json();
  await call('POST', '/api/v1/transactions', { kind: 'income', category: 'سایر', amount: 70000, occurred_on: '2026-11-05' });
  await call('DELETE', `/api/v1/transactions/${t1.id}`);
});

after(async () => { await app.close(); await db.end(); });

test('بازگردانی کامل: وضعیت پس از بازگردانی با وضعیت خروجی‌گرفته‌شده یکی است', async () => {
  const before1 = await state();
  // تغییراتی که باید پس از بازگردانی از بین بروند
  await call('POST', '/api/v1/customers', { name: 'تازه', phone: '09123333333' });
  await call('POST', '/api/v1/transactions', { kind: 'income', category: 'جدید', amount: 1000, occurred_on: '2026-11-20' });
  assert.notDeepEqual(await state(), before1);

  const res = await call('POST', '/api/v1/import/replace', before1);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().counts.customers, before1.customers.length);
  assert.equal(res.json().counts.orders, before1.orders.length);
  assert.ok(res.json().snapshot_id);
  assert.deepEqual(await state(), before1, 'وضعیت کامل، از جمله ردیف‌های حذف‌شده و تاریخچه، بازگردانی شد');
});

test('پیش از جایگزینی نسخه‌ی کامل ذخیره می‌شود و قابل بازگردانی است', async () => {
  const before2 = await state();
  await call('POST', '/api/v1/customers', { name: 'برای-نسخه', phone: '09124444444' });
  const pre = await state();
  const res = await call('POST', '/api/v1/import/replace', before2);
  assert.equal(res.statusCode, 200);
  const snapId = res.json().snapshot_id;

  const list = (await call('GET', '/api/v1/import/snapshots')).json().items;
  assert.ok(list.some((s) => s.id === snapId), 'نسخه در فهرست است');
  const snap = (await call('GET', `/api/v1/import/snapshots/${snapId}`)).json();
  const { exported_at, status_log, ...snapRest } = snap;
  assert.deepEqual(snapRest, pre, 'نسخه‌ی ذخیره‌شده دقیقاً وضعیت پیش از بازگردانی است');
  assert.ok(Array.isArray(status_log) && status_log.length >= 1, 'تاریخچه‌ی وضعیت در نسخه است');

  // بازگردانی همان نسخه، وضعیت پیش از بازگردانی را برمی‌گرداند
  const undo = await call('POST', '/api/v1/import/replace', snap);
  assert.equal(undo.statusCode, 200, undo.body);
  assert.deepEqual(await state(), pre);
});

test('فایل ناقص یا ناسازگار: 400 و هیچ داده‌ای تغییر نمی‌کند', async () => {
  const good = await state();
  const snapsBefore = (await call('GET', '/api/v1/import/snapshots')).json().items.length;

  const dupPhone = JSON.parse(JSON.stringify(good));
  dupPhone.customers.push({ ...dupPhone.customers[0], id: '00000000-0000-4000-8000-0000000000aa' });
  const r1 = await call('POST', '/api/v1/import/replace', dupPhone);
  assert.equal(r1.statusCode, 400);
  assert.equal(r1.json().error, 'invalid_backup');

  const noShop = { ...good };
  delete noShop.shop;
  assert.equal((await call('POST', '/api/v1/import/replace', noShop)).statusCode, 400);

  const badOrder = JSON.parse(JSON.stringify(good));
  badOrder.orders[0].price = -5;
  assert.equal((await call('POST', '/api/v1/import/replace', badOrder)).statusCode, 400);

  assert.equal((await call('POST', '/api/v1/import/replace', 'متن-نه-شیء')).statusCode, 400);

  assert.deepEqual(await state(), good, 'هیچ‌کدام از فایل‌های نامعتبر داده را تغییر نداد');
  assert.equal((await call('GET', '/api/v1/import/snapshots')).json().items.length, snapsBefore, 'برای فایل نامعتبر نسخه‌ی تازه ساخته نشد');
});

test('خطا وسط تراکنش: ROLLBACK کامل؛ داده و نسخه‌ی تازه‌ای نیست', async () => {
  const good = await state();
  const snapsBefore = (await db.query('SELECT count(*)::int AS n FROM shop_snapshots WHERE shop_id = $1', [shopId])).rows[0].n;
  const payload = JSON.parse(JSON.stringify(good));
  payload.customers.push({ id: '00000000-0000-4000-8000-0000000000bb', name: 'ناموفق', phone: null, note: '', tier: 'regular', deleted_at: null });
  await assert.rejects(
    replaceShopData(db, shopId, adminId, payload, {
      beforeApply: async () => { throw new Error('خطای آزمایشی وسط تراکنش'); },
    }),
    /خطای آزمایشی/
  );
  assert.deepEqual(await state(), good, 'داده‌ی اصلی دست‌نخورده است');
  const snapsAfter = (await db.query('SELECT count(*)::int AS n FROM shop_snapshots WHERE shop_id = $1', [shopId])).rows[0].n;
  assert.equal(snapsAfter, snapsBefore, 'نسخه‌ی ناتمام ذخیره نشد');
});

test('خطا هنگام درج (شناسه‌ی مزون دیگر): 409 و ROLLBACK کامل', async () => {
  const good = await state();
  const other = (await db.query("INSERT INTO shops (name) VALUES ('مزون دیگر') RETURNING id")).rows[0].id;
  const takenId = '00000000-0000-4000-8000-0000000000cc';
  await db.query(
    "INSERT INTO customers (id, shop_id, name, phone, note, tier) VALUES ($1, $2, 'مال مزون دیگر', NULL, '', 'regular')",
    [takenId, other]
  );
  const payload = JSON.parse(JSON.stringify(good));
  payload.customers.push({ id: takenId, name: 'تصادفی', phone: null, note: '', tier: 'regular', deleted_at: null });
  const res = await call('POST', '/api/v1/import/replace', payload);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'id_taken');
  assert.deepEqual(await state(), good, 'داده‌ی این مزون دست‌نخورده است');
  const owner = (await db.query('SELECT shop_id FROM customers WHERE id = $1', [takenId])).rows[0].shop_id;
  assert.equal(owner, other, 'مشتری مزون دیگر تغییر نکرد');
});

test('پشتیبان قدیمی بدون customer_id: با نام یکتای مشتری بازگردانی می‌شود', async () => {
  const good = await state();
  const legacy = JSON.parse(JSON.stringify(good));
  for (const o of legacy.orders) delete o.customer_id;
  const res = await call('POST', '/api/v1/import/replace', legacy);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(await state(), good);
});

test('حذف‌شده‌ها پس از بازگردانی هنوز حذف‌شده‌اند و بازگردانی‌پذیرند', async () => {
  const deleted = (await call('GET', '/api/v1/transactions/deleted')).json().items;
  assert.equal(deleted.length, 1);
  const id = deleted[0].id;
  // هیچ‌کدام در جمع‌ها نیست
  const sum = (await call('GET', '/api/v1/reports/summary')).json();
  assert.equal(sum.money.expense, 0, 'هزینه‌ی حذف‌شده در گزارش نیست');
  const restored = await call('POST', `/api/v1/transactions/${id}/restore`);
  assert.equal(restored.statusCode, 200);
  assert.equal((await call('GET', '/api/v1/transactions/deleted')).json().items.length, 0);
});

test('غیرمدیر به بازگردانی و نسخه‌ها دسترسی ندارد', async () => {
  const good = await state();
  assert.equal((await call('POST', '/api/v1/import/replace', good, staffCookie)).statusCode, 403);
  assert.equal((await call('GET', '/api/v1/import/snapshots', undefined, staffCookie)).statusCode, 403);
  assert.deepEqual(await state(), good);
});
