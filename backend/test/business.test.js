const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');
const { buildApp } = require('../src/app');
const { createShopAdmin } = require('../scripts/create-admin');
const { hashPassword } = require('../src/auth');

const URL = process.env.DATABASE_URL || '';
if (!/test/.test(URL)) throw new Error('DATABASE_URL باید به یک پایگاه تست اشاره کند');

const PASSWORD = 'گذرواژه‌ی-آزمایشی-۱۲۳';
let db, app, cookie, staffCookie;

async function login(email) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return res.headers['set-cookie'].split(';')[0];
}
const call = (method, url, payload, c = cookie) =>
  app.inject({ method, url, payload, headers: c ? { cookie: c } : {} });

before(async () => {
  db = createPool(URL);
  app = buildApp({ db, loginMax: 1000 });
  await app.ready();
  await db.query('TRUNCATE shops, users, sessions, customers, staff, orders, order_status_log, transactions CASCADE');
  const { shopId } = await createShopAdmin(db, { shopName: 'مزون تست', email: 'admin@test.dev', password: PASSWORD, fullName: 'مدیر' });
  // کاربر غیر مدیر برای آزمون دسترسی
  await db.query(
    `INSERT INTO users (shop_id, email, password_hash, full_name, role) VALUES ($1, 'staff@test.dev', $2, 'خیاط', 'staff')`,
    [shopId, await hashPassword(PASSWORD)]
  );
  cookie = await login('admin@test.dev');
  staffCookie = await login('staff@test.dev');
});

after(async () => { await app.close(); await db.end(); });

test('staff: admin creates, toggles and sees counts; invalid phone rejected', async () => {
  const created = await call('POST', '/api/v1/staff', { name: 'زهرا نوری', role_title: 'خیاط ارشد', phone: '۰۹۱۲۵۵۵۶۶۷۷' });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().phone, '09125556677');
  const bad = await call('POST', '/api/v1/staff', { name: 'x', phone: '12' });
  assert.equal(bad.statusCode, 400);
  const id = created.json().id;
  const off = await call('PATCH', `/api/v1/staff/${id}`, { active: false });
  assert.equal(off.json().active, false);
  assert.equal((await call('GET', '/api/v1/staff')).json().items.length, 1);
});

test('staff role cannot write to staff or settings or export', async () => {
  assert.equal((await call('POST', '/api/v1/staff', { name: 'x' }, staffCookie)).statusCode, 403);
  assert.equal((await call('PUT', '/api/v1/settings', { shop_name: 'x' }, staffCookie)).statusCode, 403);
  assert.equal((await call('GET', '/api/v1/export', undefined, staffCookie)).statusCode, 403);
  // ولی می‌تواند بخواند
  assert.equal((await call('GET', '/api/v1/staff', undefined, staffCookie)).statusCode, 200);
});

test('transactions: create, filter by kind and date, soft-delete', async () => {
  const exp = await call('POST', '/api/v1/transactions', { kind: 'expense', category: 'پارچه', amount: 2400000, occurred_on: '2026-11-02', note: 'کرپ' });
  const inc = await call('POST', '/api/v1/transactions', { kind: 'income', category: 'سایر', amount: 500000, occurred_on: '2026-11-05' });
  assert.equal(exp.statusCode, 201);
  assert.equal(inc.statusCode, 201);
  const expenses = await call('GET', '/api/v1/transactions?kind=expense');
  assert.equal(expenses.json().items.length, 1);
  const ranged = await call('GET', '/api/v1/transactions?from=2026-11-04&to=2026-11-30');
  assert.equal(ranged.json().items.length, 1);
  const badDate = await call('POST', '/api/v1/transactions', { kind: 'income', category: 'x', amount: 1, occurred_on: '1405/08/16' });
  assert.equal(badDate.statusCode, 400);
  assert.equal((await call('DELETE', `/api/v1/transactions/${exp.json().id}`)).statusCode, 200);
  assert.equal((await call('DELETE', `/api/v1/transactions/${exp.json().id}`)).statusCode, 404);
});

test('reports: money balance and order counts come from the data', async () => {
  // مشتری و دو سفارش: یکی تحویل‌شده با مبلغ ۶٬۲۰۰٬۰۰۰، یکی در انتظار
  const cust = await call('POST', '/api/v1/customers', { name: 'سارا موسوی', phone: '09117654321' });
  const o1 = await call('POST', '/api/v1/orders', { customer_id: cust.json().id, type: 'sewing', description: 'مانتو', price: 6200000 });
  await call('POST', '/api/v1/orders', { customer_id: cust.json().id, type: 'repair', description: 'کوتاهی', price: 380000 });
  await call('POST', `/api/v1/orders/${o1.json().id}/status`, { to: 'delivered' });

  const r = (await call('GET', '/api/v1/reports/summary')).json();
  assert.equal(r.orders.total, 2);
  assert.equal(r.orders.by_status.delivered, 1);
  assert.equal(r.orders.by_status.waiting, 1);
  assert.equal(r.orders.by_type.sewing, 1);
  assert.equal(r.money.order_income, 6200000);
  assert.equal(r.money.other_income, 500000);
  assert.equal(r.money.expense, 0); // هزینه‌ی ثبت‌شده‌ی آزمون قبلی حذف شد
  assert.equal(r.money.balance, 6700000);
  assert.equal(r.money.average_delivered_order, 6200000);
  assert.equal(r.top_customers[0].name, 'سارا موسوی');
});

test('settings: admin updates shop info; phone normalized; currency stored', async () => {
  const res = await call('PUT', '/api/v1/settings', { shop_name: 'مزون دوخت‌یار', phone: '۰۲۱۱۲۳۴۵۶۷۸', currency: 'تومان' });
  assert.equal(res.statusCode, 400); // تلفن ثابت پذیرفته نیست
  const ok = await call('PUT', '/api/v1/settings', { shop_name: 'مزون دوخت‌یار', phone: '۰۹۱۲۰۰۰۰۰۰۱', address: 'تهران' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().phone, '09120000001');
  assert.equal((await call('GET', '/api/v1/settings')).json().shop_name, 'مزون دوخت‌یار');
});

test('export: admin gets a complete JSON backup without deleted rows', async () => {
  const res = await call('GET', '/api/v1/export');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.shop.shop_name, 'مزون دوخت‌یار');
  assert.ok(Array.isArray(body.customers) && body.customers.length >= 1);
  assert.ok(Array.isArray(body.orders) && body.orders.length === 2);
  assert.ok(Array.isArray(body.transactions));
  assert.ok(!JSON.stringify(body).includes('password_hash'));
});
