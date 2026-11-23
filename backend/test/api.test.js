const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');
const { buildApp } = require('../src/app');
const { createShopAdmin } = require('../scripts/create-admin');

const URL = process.env.DATABASE_URL || '';
if (!/test/.test(URL)) {
  throw new Error('DATABASE_URL باید به یک پایگاه تست اشاره کند (نام شامل "test")');
}

const EMAIL = 'admin@test.dev';
const PASSWORD = 'گذرواژه‌ی-آزمایشی-۱۲۳';
let db;
let app;
let cookie;

async function resetAndSeed() {
  await db.query('TRUNCATE shops, users, sessions, customers, staff, orders, order_status_log, transactions CASCADE');
  await createShopAdmin(db, { shopName: 'مزون تست', email: EMAIL, password: PASSWORD, fullName: 'مدیر تست' });
}

async function login(email = EMAIL, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
}

async function call(method, url, payload, c = cookie) {
  return app.inject({ method, url, payload, headers: c ? { cookie: c } : {} });
}

before(async () => {
  db = createPool(URL);
  app = buildApp({ db, loginMax: 1000 });
  await app.ready();
  await resetAndSeed();
  const res = await login();
  cookie = res.headers['set-cookie'].split(';')[0];
});

after(async () => {
  await app.close();
  await db.end();
});

test('healthz is public', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/healthz' });
  assert.equal(res.statusCode, 200);
});

test('login: wrong password and unknown email get the same 401', async () => {
  const wrong = await login(EMAIL, 'اشتباه-اشتباه');
  const unknown = await login('nobody@test.dev', PASSWORD);
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.json().error, unknown.json().error);
});

test('login: email is case-insensitive and sets an HttpOnly SameSite cookie', async () => {
  const res = await login('ADMIN@test.dev', PASSWORD);
  assert.equal(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal(res.json().user.role, 'admin');
  assert.equal(res.json().user.password_hash, undefined);
});

test('protected routes require a session', async () => {
  const res = await call('GET', '/api/v1/customers', undefined, null);
  assert.equal(res.statusCode, 401);
});

test('auth/me returns the current user', async () => {
  const res = await call('GET', '/api/v1/auth/me');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.email, EMAIL);
});

test('customers: create, normalize Persian phone digits, reject duplicates and bad phones', async () => {
  const ok = await call('POST', '/api/v1/customers', { name: 'مریم احمدی', phone: '۰۹۱۲۳۴۵۶۷۸۹', tier: 'vip' });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().phone, '09123456789');
  assert.equal(ok.json().tier, 'vip');

  const dup = await call('POST', '/api/v1/customers', { name: 'تکراری', phone: '09123456789' });
  assert.equal(dup.statusCode, 409);

  const bad = await call('POST', '/api/v1/customers', { name: 'نادرست', phone: '0912' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_phone');
});

test('customers: search by name and phone', async () => {
  await call('POST', '/api/v1/customers', { name: 'نگار رضایی', phone: '09351234567' });
  const byName = await call('GET', '/api/v1/customers?q=نگار');
  assert.equal(byName.json().items.length, 1);
  const byPhone = await call('GET', '/api/v1/customers?q=0935');
  assert.equal(byPhone.json().items[0].name, 'نگار رضایی');
});

test('customers: patch with stale version returns 409', async () => {
  const list = await call('GET', '/api/v1/customers?q=مریم');
  const c = list.json().items[0];
  const first = await call('PATCH', `/api/v1/customers/${c.id}`, { note: 'یادداشت ۱', version: c.version });
  assert.equal(first.statusCode, 200);
  const stale = await call('PATCH', `/api/v1/customers/${c.id}`, { note: 'یادداشت ۲', version: c.version });
  assert.equal(stale.statusCode, 409);
});

test('customers: soft delete hides the row from lists', async () => {
  const list = await call('GET', '/api/v1/customers?q=نگار');
  const id = list.json().items[0].id;
  const del = await call('DELETE', `/api/v1/customers/${id}`);
  assert.equal(del.statusCode, 200);
  const after = await call('GET', '/api/v1/customers?q=نگار');
  assert.equal(after.json().items.length, 0);
});

test('orders: order numbers are sequential per shop and price is a number', async () => {
  const cust = (await call('GET', '/api/v1/customers?q=مریم')).json().items[0];
  const a = await call('POST', '/api/v1/orders', {
    customer_id: cust.id, type: 'sewing', description: 'دوخت مانتو', price: 6200000, due_on: '2026-11-20',
  });
  const b = await call('POST', '/api/v1/orders', { customer_id: cust.id, type: 'repair', description: 'کوتاهی' });
  assert.equal(a.statusCode, 201);
  assert.equal(a.json().order_no, 1);
  assert.equal(b.json().order_no, 2);
  assert.equal(a.json().price, 6200000);
  assert.equal(a.json().due_on, '2026-11-20');
  assert.equal(a.json().customer_name, 'مریم احمدی');
});

test('orders: unknown or deleted customer is rejected', async () => {
  const res = await call('POST', '/api/v1/orders', {
    customer_id: '00000000-0000-4000-8000-000000000000', type: 'sewing', description: 'x',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'customer_not_found');
});

test('orders: status change is logged and stale version is rejected', async () => {
  const list = (await call('GET', '/api/v1/orders?status=waiting')).json().items;
  const o = list[0];
  const ok = await call('POST', `/api/v1/orders/${o.id}/status`, { to: 'progress', version: o.version });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, 'progress');

  const logged = await db.query('SELECT from_status, to_status FROM order_status_log WHERE order_id = $1 ORDER BY id', [o.id]);
  assert.deepEqual(logged.rows.map((r) => r.to_status), ['waiting', 'progress']);

  const stale = await call('POST', `/api/v1/orders/${o.id}/status`, { to: 'ready', version: o.version });
  assert.equal(stale.statusCode, 409);
});

test('orders: invalid status and filter values are rejected', async () => {
  const o = (await call('GET', '/api/v1/orders')).json().items[0];
  const bad = await call('POST', `/api/v1/orders/${o.id}/status`, { to: 'lost', version: o.version });
  assert.equal(bad.statusCode, 400);
  const badFilter = await call('GET', '/api/v1/orders?status=lost');
  assert.equal(badFilter.statusCode, 400);
});

test('tenant isolation: another shop cannot read or change these records', async () => {
  await createShopAdmin(db, { shopName: 'مزون دوم', email: 'other@test.dev', password: PASSWORD, fullName: 'دیگری' });
  const otherCookie = (await login('other@test.dev')).headers['set-cookie'].split(';')[0];
  const cust = (await call('GET', '/api/v1/customers?q=مریم')).json().items[0];
  const read = await call('GET', `/api/v1/customers/${cust.id}`, undefined, otherCookie);
  assert.equal(read.statusCode, 404);
  const patch = await call('PATCH', `/api/v1/customers/${cust.id}`, { note: 'hack' }, otherCookie);
  assert.equal(patch.statusCode, 404);
  const orders = await call('GET', '/api/v1/orders', undefined, otherCookie);
  assert.equal(orders.json().items.length, 0);
});

test('logout revokes the session', async () => {
  const res = await login();
  const c = res.headers['set-cookie'].split(';')[0];
  assert.equal((await call('GET', '/api/v1/auth/me', undefined, c)).statusCode, 200);
  assert.equal((await call('POST', '/api/v1/auth/logout', undefined, c)).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/auth/me', undefined, c)).statusCode, 401);
});

test('login is rate limited', async () => {
  const limited = buildApp({ db, loginMax: 2 });
  await limited.ready();
  const attempt = () => limited.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAIL, password: 'x' } });
  await attempt();
  await attempt();
  const third = await attempt();
  assert.equal(third.statusCode, 429);
  await limited.close();
});
