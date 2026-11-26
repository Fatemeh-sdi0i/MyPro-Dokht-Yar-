// بازگردانی حذف‌نرم‌شده‌ی مشتری، سفارش و همکار (گام ۱ فاز Undo).
// همه‌ی داده‌ها آزمایشی‌اند و فقط روی پایگاه تست نوشته می‌شوند.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');
const { buildApp } = require('../src/app');
const { createShopAdmin } = require('../scripts/create-admin');
const { hashPassword } = require('../src/auth');

const URL = process.env.DATABASE_URL || '';
if (!/test/.test(URL)) throw new Error('DATABASE_URL باید به یک پایگاه تست اشاره کند');
const PASSWORD = 'گذرواژه‌ی-آزمایشی-۱۲۳';
let db, app, adminCookie, staffCookie, shopId;

const login = async (email) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return res.headers['set-cookie'].split(';')[0];
};
const call = (method, url, payload, cookie = adminCookie) => app.inject({ method, url, payload, headers: { cookie } });

before(async () => {
  db = createPool(URL);
  app = buildApp({ db, loginMax: 1000 });
  await app.ready();
  await db.query('TRUNCATE shops, users, sessions, customers, staff, orders, order_status_log, transactions, shop_snapshots CASCADE');
  const made = await createShopAdmin(db, { shopName: 'مزون بازگردانی‌ها', email: 'admin@entities.dev', password: PASSWORD, fullName: 'مدیر' });
  shopId = made.shopId;
  await db.query(
    "INSERT INTO users (shop_id, email, password_hash, full_name, role) VALUES ($1, 'staff@entities.dev', $2, 'خیاط', 'staff')",
    [shopId, await hashPassword(PASSWORD)]
  );
  adminCookie = await login('admin@entities.dev');
  staffCookie = await login('staff@entities.dev');
});
after(async () => { await app.close(); await db.end(); });

// ---------- مشتری ----------

test('مشتری: حذف با نسخه‌ی قدیمی ۴۰۹ می‌دهد؛ با نسخه‌ی درست حذف و بازگردانی می‌شود', async () => {
  const c = (await call('POST', '/api/v1/customers', { name: 'نرگس', phone: '09131110001' })).json();

  const stale = await call('DELETE', `/api/v1/customers/${c.id}?version=${c.version + 5}`);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'version_conflict');
  assert.equal((await db.query('SELECT deleted_at FROM customers WHERE id = $1', [c.id])).rows[0].deleted_at, null, 'ردیف دست‌نخورده است');

  assert.equal((await call('DELETE', `/api/v1/customers/${c.id}?version=${c.version}`)).statusCode, 200);
  assert.ok((await db.query('SELECT deleted_at FROM customers WHERE id = $1', [c.id])).rows[0].deleted_at, 'حذف نرم شده');
  assert.ok(!(await call('GET', '/api/v1/customers')).json().items.some((x) => x.id === c.id), 'در فهرست فعال نیست');
  assert.ok((await call('GET', '/api/v1/customers/deleted')).json().items.some((x) => x.id === c.id && x.deleted_at));

  const back = await call('POST', `/api/v1/customers/${c.id}/restore`);
  assert.equal(back.statusCode, 200);
  assert.equal(back.json().id, c.id);
  assert.equal(back.json().name, 'نرگس');
  assert.ok((await call('GET', '/api/v1/customers')).json().items.some((x) => x.id === c.id), 'دوباره فعال است');
  assert.equal((await call('POST', `/api/v1/customers/${c.id}/restore`)).statusCode, 404, 'بازگردانی دوباره انجام نمی‌شود');
});

test('مشتری: بازگردانی وقتی شماره‌ی تماسش به مشتری فعال دیگری رسیده ۴۰۹ می‌دهد و چیزی را بازنویسی نمی‌کند', async () => {
  const a = (await call('POST', '/api/v1/customers', { name: 'الف', phone: '09131110002' })).json();
  await call('DELETE', `/api/v1/customers/${a.id}`);
  const b = (await call('POST', '/api/v1/customers', { name: 'ب', phone: '09131110002' })).json();
  assert.equal(b.phone, '09131110002', 'مشتری فعال دیگری با همان شماره ثبت شده');

  const res = await call('POST', `/api/v1/customers/${a.id}/restore`);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'phone_taken');
  assert.ok((await db.query('SELECT deleted_at FROM customers WHERE id = $1', [a.id])).rows[0].deleted_at, 'مشتری الف همچنان حذف‌شده است');
  assert.equal((await db.query('SELECT name FROM customers WHERE id = $1', [b.id])).rows[0].name, 'ب', 'مشتری فعال دست‌نخورده است');
});

test('مشتری: بازگردانی مشتری مزون دیگر ممکن نیست', async () => {
  const other = (await db.query("INSERT INTO shops (name) VALUES ('مزون بیگانه‌ی مشتری') RETURNING id")).rows[0].id;
  const foreign = (await db.query(
    "INSERT INTO customers (shop_id, name, phone, deleted_at) VALUES ($1, 'غریبه', NULL, now()) RETURNING id",
    [other]
  )).rows[0].id;
  assert.equal((await call('POST', `/api/v1/customers/${foreign}/restore`)).statusCode, 404);
  assert.ok((await db.query('SELECT deleted_at FROM customers WHERE id = $1', [foreign])).rows[0].deleted_at, 'دست‌نخورده');
});

// ---------- سفارش ----------

test('سفارش: حذف و بازگردانی با نسخه؛ شماره‌ی سفارش ثابت می‌ماند', async () => {
  const c = (await call('POST', '/api/v1/customers', { name: 'مریم', phone: '09131110003' })).json();
  const o = (await call('POST', '/api/v1/orders', { customer_id: c.id, type: 'repair', description: 'زیپ', price: 50000 })).json();

  assert.equal((await call('DELETE', `/api/v1/orders/${o.id}?version=${o.version + 1}`)).statusCode, 409);
  assert.equal((await call('DELETE', `/api/v1/orders/${o.id}?version=${o.version}`)).statusCode, 200);
  assert.ok((await call('GET', '/api/v1/orders/deleted')).json().items.some((x) => x.id === o.id && x.deleted_at));
  assert.ok(!(await call('GET', '/api/v1/orders')).json().items.some((x) => x.id === o.id));

  const back = await call('POST', `/api/v1/orders/${o.id}/restore`);
  assert.equal(back.statusCode, 200);
  assert.equal(back.json().order_no, o.order_no, 'شماره‌ی سفارش تغییر نکرده');
  assert.equal(back.json().status, 'waiting');
  assert.equal((await call('POST', `/api/v1/orders/${o.id}/restore`)).statusCode, 404);
});

test('سفارش: بازگردانی وقتی مشتری‌اش حذف است ۴۰۹ می‌دهد و پس از بازگردانی مشتری کار می‌کند', async () => {
  const c = (await call('POST', '/api/v1/customers', { name: 'نیلوفر', phone: '09131110004' })).json();
  const o = (await call('POST', '/api/v1/orders', { customer_id: c.id, type: 'sewing', description: 'پیراهن', price: 300000 })).json();
  await call('DELETE', `/api/v1/orders/${o.id}?version=${o.version}`);
  await call('DELETE', `/api/v1/customers/${c.id}`);

  const blocked = await call('POST', `/api/v1/orders/${o.id}/restore`);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error, 'customer_deleted');
  assert.ok((await db.query('SELECT deleted_at FROM orders WHERE id = $1', [o.id])).rows[0].deleted_at, 'سفارش همچنان حذف‌شده است');

  assert.equal((await call('POST', `/api/v1/customers/${c.id}/restore`)).statusCode, 200);
  assert.equal((await call('POST', `/api/v1/orders/${o.id}/restore`)).statusCode, 200);
});

test('سفارش: ایجاد سفارش جدید پس از حذف، شماره‌ی حذف‌شده را دوباره نمی‌دهد', async () => {
  const c = (await call('POST', '/api/v1/customers', { name: 'شیدا', phone: '09131110005' })).json();
  const o = (await call('POST', '/api/v1/orders', { customer_id: c.id, type: 'repair', description: 'دکمه', price: 1000 })).json();
  await call('DELETE', `/api/v1/orders/${o.id}`);
  const next = (await call('POST', '/api/v1/orders', { customer_id: c.id, type: 'repair', description: 'کمربند', price: 1000 })).json();
  assert.ok(next.order_no > o.order_no, 'شماره‌ی تازه از شماره‌ی حذف‌شده بزرگ‌تر است');
});

// ---------- همکار ----------

test('همکار: حذف، مسدودسازی ورود حساب متصل، و بازگردانی فقط همان مسدودسازی را برمی‌دارد', async () => {
  const s = (await call('POST', '/api/v1/staff', { name: 'کامران', role_title: 'برش‌کار' })).json();
  const user = (await db.query(
    "INSERT INTO users (shop_id, email, password_hash, full_name, role) VALUES ($1, 'kamran@entities.dev', $2, 'کامران', 'staff') RETURNING id",
    [shopId, await hashPassword(PASSWORD)]
  )).rows[0].id;
  await db.query('UPDATE staff SET user_id = $1 WHERE id = $2', [user, s.id]);

  // نسخه‌ی قدیمی ۴۰۹ می‌دهد و حساب را مسدود نمی‌کند
  assert.equal((await call('DELETE', `/api/v1/staff/${s.id}?version=${s.version + 1}`)).statusCode, 409);
  assert.equal((await db.query('SELECT disabled_at FROM users WHERE id = $1', [user])).rows[0].disabled_at, null);

  assert.equal((await call('DELETE', `/api/v1/staff/${s.id}?version=${s.version}`)).statusCode, 200);
  assert.ok((await db.query('SELECT disabled_at FROM users WHERE id = $1', [user])).rows[0].disabled_at, 'حساب مسدود شد');
  assert.ok((await db.query('SELECT id FROM users WHERE id = $1', [user])).rows[0], 'حساب حذف نشد');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [user])).rows[0].n, 1);
  assert.ok((await call('GET', '/api/v1/staff/deleted')).json().items.some((x) => x.id === s.id));

  const back = await call('POST', `/api/v1/staff/${s.id}/restore`);
  assert.equal(back.statusCode, 200);
  assert.equal(back.json().name, 'کامران');
  assert.equal((await db.query('SELECT disabled_at FROM users WHERE id = $1', [user])).rows[0].disabled_at, null, 'ورود دوباره برقرار شد');
});

test('همکار: حسابی که پیش از حذف مدیر غیرفعال کرده، با بازگردانی همکار فعال نمی‌شود', async () => {
  const s = (await call('POST', '/api/v1/staff', { name: 'پارسا', role_title: 'دوخت' })).json();
  const user = (await db.query(
    "INSERT INTO users (shop_id, email, password_hash, full_name, role, disabled_at) VALUES ($1, 'parsa@entities.dev', $2, 'پارسا', 'staff', '2020-01-01T00:00:00Z') RETURNING id",
    [shopId, await hashPassword(PASSWORD)]
  )).rows[0].id;
  await db.query('UPDATE staff SET user_id = $1 WHERE id = $2', [user, s.id]);

  await call('DELETE', `/api/v1/staff/${s.id}`);
  assert.equal((await call('POST', `/api/v1/staff/${s.id}/restore`)).statusCode, 200);
  assert.ok((await db.query('SELECT disabled_at FROM users WHERE id = $1', [user])).rows[0].disabled_at, 'غیرفعال‌سازی قبلی دست‌نخورده است');
});

test('همکار: کاربر غیر مدیر نمی‌تواند حذف یا بازگردانی یا فهرست حذف‌شده‌ها را ببیند', async () => {
  const s = (await call('POST', '/api/v1/staff', { name: 'نسترن', role_title: 'منشی' })).json();
  assert.equal((await call('DELETE', `/api/v1/staff/${s.id}`, undefined, staffCookie)).statusCode, 403);
  await call('DELETE', `/api/v1/staff/${s.id}`);
  assert.equal((await call('POST', `/api/v1/staff/${s.id}/restore`, undefined, staffCookie)).statusCode, 403);
  assert.equal((await call('GET', '/api/v1/staff/deleted', undefined, staffCookie)).statusCode, 403);
  assert.equal((await call('POST', `/api/v1/staff/${s.id}/restore`)).statusCode, 200);
});

test('همکار: بازگردانی همکار حذف‌نشده ۴۰۴ می‌دهد', async () => {
  const s = (await call('POST', '/api/v1/staff', { name: 'ژیلا', role_title: 'برش' })).json();
  assert.equal((await call('POST', `/api/v1/staff/${s.id}/restore`)).statusCode, 404);
});
