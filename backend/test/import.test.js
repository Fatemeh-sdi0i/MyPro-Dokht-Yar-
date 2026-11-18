// انتقال داده‌ی قبلی: شماره و تاریخ ایجاد اصلی سفارش حفظ می‌شوند؛ فقط مدیر مجاز است.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');
const { buildApp } = require('../src/app');
const { createShopAdmin } = require('../scripts/create-admin');
const { hashPassword } = require('../src/auth');

const URL = process.env.DATABASE_URL || '';
if (!/test/.test(URL)) {
  throw new Error('DATABASE_URL باید به یک پایگاه تست اشاره کند (نام شامل "test")');
}

const ADMIN = { email: 'admin@import.test', password: 'گذرواژه‌ی-آزمایشی-۱۲۳' };
const STAFF = { email: 'staff@import.test', password: 'گذرواژه‌ی-کارمند-۴۵۶' };
let db;
let app;
let adminCookie;
let staffCookie;
let customerId;

async function login(who) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: who });
  return res.headers['set-cookie'].split(';')[0];
}

async function post(payload, cookie = adminCookie) {
  return app.inject({ method: 'POST', url: '/api/v1/orders', payload, headers: { cookie } });
}

before(async () => {
  db = createPool(URL);
  app = buildApp({ db, loginMax: 1000 });
  await app.ready();
  await db.query('TRUNCATE shops, users, sessions, customers, staff, orders, order_status_log, transactions CASCADE');
  await createShopAdmin(db, { shopName: 'مزون انتقال', email: ADMIN.email, password: ADMIN.password, fullName: 'مدیر' });
  const shop = (await db.query('SELECT id FROM shops LIMIT 1')).rows[0];
  await db.query(
    `INSERT INTO users (shop_id, email, password_hash, full_name, role) VALUES ($1, $2, $3, $4, 'staff')`,
    [shop.id, STAFF.email, await hashPassword(STAFF.password), 'کارمند']
  );
  adminCookie = await login(ADMIN);
  staffCookie = await login(STAFF);
  const c = await app.inject({
    method: 'POST', url: '/api/v1/customers', payload: { name: 'مشتری انتقال' },
    headers: { cookie: adminCookie },
  });
  customerId = c.json().id;
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('import: admin keeps original order number and creation date', async () => {
  const res = await post({
    customer_id: customerId, type: 'sewing', description: 'کت قدیمی', price: 7400000,
    status: 'delivered', due_on: '2026-10-01', order_no: 17, created_on: '2026-09-20',
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.order_no, 17);
  assert.equal(body.created_on, '2026-09-20');
  assert.equal(body.due_on, '2026-10-01');
});

test('import: a later normal order continues after the highest imported number', async () => {
  const res = await post({ customer_id: customerId, type: 'repair', description: 'زیپ جدید' });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().order_no, 18);
  assert.equal(res.json().created_on, new Date().toISOString().slice(0, 10));
});

test('import: duplicate order number is rejected', async () => {
  const res = await post({ customer_id: customerId, type: 'sewing', description: 'تکراری', order_no: 17 });
  assert.equal(res.statusCode, 409, res.body);
});

test('import: staff cannot set order number or creation date', async () => {
  const byNo = await post({ customer_id: customerId, type: 'sewing', description: 'کارمند', order_no: 50 }, staffCookie);
  assert.equal(byNo.statusCode, 403, byNo.body);
  const byDate = await post({ customer_id: customerId, type: 'sewing', description: 'کارمند', created_on: '2026-01-01' }, staffCookie);
  assert.equal(byDate.statusCode, 403, byDate.body);
});

test('import: staff can still create normal orders', async () => {
  const res = await post({ customer_id: customerId, type: 'sewing', description: 'سفارش عادی' }, staffCookie);
  assert.equal(res.statusCode, 201, res.body);
});

test('import: invalid creation date and order number are rejected', async () => {
  const badDate = await post({ customer_id: customerId, type: 'sewing', description: 'x', created_on: '1405/08/20' });
  assert.equal(badDate.statusCode, 400, badDate.body);
  const badNo = await post({ customer_id: customerId, type: 'sewing', description: 'x', order_no: 0 });
  assert.equal(badNo.statusCode, 400, badNo.body);
});
