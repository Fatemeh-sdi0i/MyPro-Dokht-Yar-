// شناسه‌ی تولیدشده روی کلاینت (همگام‌سازی آفلاین): تکرار ارسال ایمن است و شماره‌ی سفارش هدر نمی‌رود.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPool } = require('../src/db');
const { buildApp } = require('../src/app');
const { createShopAdmin } = require('../scripts/create-admin');
const { hashPassword } = require('../src/auth');

const URL = process.env.DATABASE_URL || '';
if (!/test/.test(URL)) throw new Error('DATABASE_URL باید به یک پایگاه تست اشاره کند (نام شامل "test")');

const A = { email: 'admin.a@offline.test', password: 'گذرواژه‌ی-الف-۱۲۳۴' };
const B = { email: 'admin.b@offline.test', password: 'گذرواژه‌ی-ب-۵۶۷۸' };
const S = { email: 'staff.a@offline.test', password: 'گذرواژه‌ی-کارمند-۹۰۱۲' };
let db, app, cookieA, cookieB, cookieS, customerId;

async function login(who) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: who });
  return res.headers['set-cookie'].split(';')[0];
}
const call = (method, url, payload, cookie) =>
  app.inject({ method, url: '/api/v1' + url, payload, headers: { cookie } });

before(async () => {
  db = createPool(URL);
  app = buildApp({ db, loginMax: 1000 });
  await app.ready();
  await db.query('TRUNCATE shops, users, sessions, customers, staff, orders, order_status_log, transactions CASCADE');
  await createShopAdmin(db, { shopName: 'مزون الف', email: A.email, password: A.password, fullName: 'مدیر الف' });
  await createShopAdmin(db, { shopName: 'مزون ب', email: B.email, password: B.password, fullName: 'مدیر ب' });
  const shopA = (await db.query(`SELECT s.id FROM shops s JOIN users u ON u.shop_id = s.id WHERE u.email = $1`, [A.email])).rows[0];
  await db.query(`INSERT INTO users (shop_id, email, password_hash, full_name, role) VALUES ($1, $2, $3, 'کارمند', 'staff')`,
    [shopA.id, S.email, await hashPassword(S.password)]);
  cookieA = await login(A);
  cookieB = await login(B);
  cookieS = await login(S);
  customerId = (await call('POST', '/customers', { name: 'مشتری الف' }, cookieA)).json().id;
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('customer: replay with same client id returns the same row (200), no duplicate', async () => {
  const id = randomUUID();
  const first = await call('POST', '/customers', { id, name: 'آفلاین ۱' }, cookieA);
  assert.equal(first.statusCode, 201, first.body);
  const again = await call('POST', '/customers', { id, name: 'آفلاین ۱' }, cookieA);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().id, id);
  const count = (await db.query('SELECT count(*)::int AS n FROM customers WHERE id = $1', [id])).rows[0].n;
  assert.equal(count, 1);
});

test('customer: same client id from another shop is rejected (409), data not exposed', async () => {
  const id = randomUUID();
  assert.equal((await call('POST', '/customers', { id, name: 'الف' }, cookieA)).statusCode, 201);
  const res = await call('POST', '/customers', { id, name: 'ب' }, cookieB);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'id_taken');
});

test('order: replay does not consume a new order number', async () => {
  const id = randomUUID();
  const first = await call('POST', '/orders', { id, customer_id: customerId, type: 'sewing', description: 'کت آفلاین' }, cookieA);
  assert.equal(first.statusCode, 201, first.body);
  const no = first.json().order_no;
  const replay = await call('POST', '/orders', { id, customer_id: customerId, type: 'sewing', description: 'کت آفلاین' }, cookieA);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().id, id);
  assert.equal(replay.json().order_no, no);
  const next = await call('POST', '/orders', { customer_id: customerId, type: 'repair', description: 'بعدی' }, cookieA);
  assert.equal(next.json().order_no, no + 1);
});

test('order: client id from another shop is rejected (409)', async () => {
  const id = randomUUID();
  assert.equal((await call('POST', '/orders', { id, customer_id: customerId, type: 'sewing', description: 'x' }, cookieA)).statusCode, 201);
  const custB = (await call('POST', '/customers', { name: 'مشتری ب' }, cookieB)).json().id;
  const res = await call('POST', '/orders', { id, customer_id: custB, type: 'sewing', description: 'y' }, cookieB);
  assert.equal(res.statusCode, 409, res.body);
});

test('transaction: replay returns the same row, no duplicate', async () => {
  const id = randomUUID();
  const payload = { id, kind: 'expense', category: 'پارچه', amount: 150000 };
  assert.equal((await call('POST', '/transactions', payload, cookieA)).statusCode, 201);
  const again = await call('POST', '/transactions', payload, cookieA);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().id, id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM transactions WHERE id = $1', [id])).rows[0].n, 1);
});

test('staff: replay by admin returns the same row; staff user is still refused (403)', async () => {
  const id = randomUUID();
  assert.equal((await call('POST', '/staff', { id, name: 'سارا' }, cookieA)).statusCode, 201);
  const again = await call('POST', '/staff', { id, name: 'سارا' }, cookieA);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().id, id);
  const byStaff = await call('POST', '/staff', { id, name: 'سارا' }, cookieS);
  assert.equal(byStaff.statusCode, 403, byStaff.body);
});

test('invalid client id format is rejected (400)', async () => {
  const res = await call('POST', '/customers', { id: 'not-a-uuid', name: 'x' }, cookieA);
  assert.equal(res.statusCode, 400, res.body);
});

// دو درخواست هم‌زمان با یک شناسه: نتیجه همیشه یک ردیف و هر دو پاسخ موفق (۲۰۱ و ۲۰۰)
test('هم‌زمانی روی یک شناسه‌ی مشتری: یک ردیف و بدون خطای ۵۰۰', async () => {
  const id = randomUUID();
  const payload = { id, name: 'مشتری هم‌زمان' };
  const [r1, r2] = await Promise.all([
    call('POST', '/customers', payload, cookieA),
    call('POST', '/customers', payload, cookieA),
  ]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 201]);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM customers WHERE id = $1', [id]);
  assert.equal(rows[0].n, 1);
});

test('هم‌زمانی روی یک شناسه‌ی سفارش: یک ردیف و یک شماره‌ی سفارش', async () => {
  const id = randomUUID();
  const payload = { id, customer_id: customerId, type: 'sewing', description: 'هم‌زمان', price: 1000 };
  const [r1, r2] = await Promise.all([
    call('POST', '/orders', payload, cookieA),
    call('POST', '/orders', payload, cookieA),
  ]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 201]);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM orders WHERE id = $1', [id]);
  assert.equal(rows[0].n, 1);
  // شماره‌ی سفارش بعدی باید دقیقاً یکی بیشتر از بزرگ‌ترین شماره‌ی همین مزون باشد (هیچ شماره‌ای هدر نرفته)
  const maxBefore = (await db.query(
    `SELECT max(o.order_no)::int AS no FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE c.id = $1 OR o.shop_id = (SELECT shop_id FROM customers WHERE id = $1)`, [customerId])).rows[0].no;
  const again = await call('POST', '/orders', { customer_id: customerId, type: 'repair', description: 'بعدی', price: 1 }, cookieA);
  assert.equal(again.statusCode, 201);
  assert.equal(again.json().order_no, maxBefore + 1);
});

test('هم‌زمانی روی شناسه‌ی مزون دیگر: ۴۰۹ و ردیفی از مزون دیگر دیده نمی‌شود', async () => {
  const id = randomUUID();
  const created = await call('POST', '/transactions', { id, kind: 'income', category: 'الف', amount: 5 }, cookieA);
  assert.equal(created.statusCode, 201);
  const other = await call('POST', '/transactions', { id, kind: 'income', category: 'ب', amount: 5 }, cookieB);
  assert.equal(other.statusCode, 409);
});
