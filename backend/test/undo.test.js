// حذف نرم و بازگردانی تراکنش: فقط برای مزون خودی، و هر بازگردانی یک‌بار.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');
const { buildApp } = require('../src/app');
const { createShopAdmin } = require('../scripts/create-admin');

const URL = process.env.DATABASE_URL || '';
if (!/test/.test(URL)) throw new Error('DATABASE_URL باید به یک پایگاه تست اشاره کند');
const PASSWORD = 'گذرواژه‌ی-آزمایشی-۱۲۳';
let db, app, cookie;

const call = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie } });

before(async () => {
  db = createPool(URL);
  app = buildApp({ db, loginMax: 1000 });
  await app.ready();
  await db.query('TRUNCATE shops, users, sessions, customers, staff, orders, order_status_log, transactions, shop_snapshots CASCADE');
  await createShopAdmin(db, { shopName: 'مزون حذف', email: 'admin@undo.dev', password: PASSWORD, fullName: 'مدیر' });
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@undo.dev', password: PASSWORD } });
  cookie = res.headers['set-cookie'].split(';')[0];
});
after(async () => { await app.close(); await db.end(); });

test('حذف نرم: ردیف می‌ماند، در جمع‌ها نیست، و با بازگردانی برمی‌گردد', async () => {
  const tx = (await call('POST', '/api/v1/transactions', { kind: 'income', category: 'سایر', amount: 120000, occurred_on: '2026-11-03' })).json();
  assert.equal((await call('GET', '/api/v1/reports/summary')).json().money.other_income, 120000);

  assert.equal((await call('DELETE', `/api/v1/transactions/${tx.id}`)).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/reports/summary')).json().money.other_income, 0);
  const row = (await db.query('SELECT amount, deleted_at FROM transactions WHERE id = $1', [tx.id])).rows[0];
  assert.equal(row.amount, 120000, 'مبلغ در پایگاه داده نگه داشته شده است');
  assert.ok(row.deleted_at, 'ردیف حذف نرم شده است');

  const deleted = (await call('GET', '/api/v1/transactions/deleted')).json().items;
  assert.ok(deleted.some((t) => t.id === tx.id && t.amount === 120000 && t.deleted_at));

  assert.equal((await call('POST', `/api/v1/transactions/${tx.id}/restore`)).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/reports/summary')).json().money.other_income, 120000);
  assert.equal((await call('POST', `/api/v1/transactions/${tx.id}/restore`)).statusCode, 404, 'بازگردانی دوباره انجام نمی‌شود');
});

test('بازگردانی تراکنش مزون دیگر ممکن نیست', async () => {
  const other = (await db.query("INSERT INTO shops (name) VALUES ('مزون بیگانه') RETURNING id")).rows[0].id;
  const foreign = (await db.query(
    "INSERT INTO transactions (shop_id, kind, category, amount, occurred_on, deleted_at) VALUES ($1, 'expense', 'غریبه', 500, '2026-11-01', now()) RETURNING id",
    [other]
  )).rows[0].id;
  assert.equal((await call('POST', `/api/v1/transactions/${foreign}/restore`)).statusCode, 404);
  const still = (await db.query('SELECT deleted_at FROM transactions WHERE id = $1', [foreign])).rows[0];
  assert.ok(still.deleted_at, 'تراکنش مزون دیگر دست‌نخورده است');
});
