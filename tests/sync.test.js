// تست واحد صف آفلاین (js/sync.js) با Api ساختگی؛ IndexedDB نیست، پس حافظه‌ی داخلی استفاده می‌شود.
const { test } = require('node:test');
const assert = require('node:assert/strict');

let responder = null;
const calls = [];
globalThis.Api = {
  call: async (method, path, body) => {
    calls.push({ method, path, body });
    return responder ? responder(method, path, body) : {};
  },
};
require('../js/sync.js');
const Sync = globalThis.Sync;

const err = (status, message = 'خطا') => Object.assign(new Error(message), { status });
const netErr = () => err(0, 'network');
const reset = () => { calls.length = 0; responder = null; };
let uid = 0;
const user = () => `user-${++uid}`; // هر تست کاربر جدا دارد، پس حالت مشترک بین تست‌ها مزاحم نیست

test('تغییر بدون اتصال در صف همان کاربر می‌ماند و با اتصال ارسال می‌شود', async () => {
  reset();
  const u = user();
  await Sync.setScope(u);
  responder = () => { throw netErr(); };
  const r = await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'الف' });
  assert.equal(r.queued, true);
  assert.equal(await Sync.pendingCount(), 1);

  responder = null;
  const res = await Sync.flush();
  assert.equal(res.sent, 1);
  assert.equal(await Sync.pendingCount(), 0);
});

test('جداسازی شاپ‌ها: کاربر دیگر صف را نمی‌بیند و ارسال نمی‌کند', async () => {
  reset();
  const a = user(), b = user();
  await Sync.setScope(a);
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'فقط برای الف' });

  await Sync.setScope(b);
  assert.equal(await Sync.pendingCount(), 0);
  calls.length = 0; // فراخوانی ارسال اولیه‌ی کاربر الف را کنار می‌گذاریم
  responder = null;
  const res = await Sync.flush();
  assert.equal(res.sent, 0);
  assert.equal(calls.length, 0, 'کاربر ب هیچ درخواستی نباید بفرستد');

  await Sync.setScope(a);
  assert.equal(await Sync.pendingCount(), 1, 'صف کاربر الف دست‌نخورده است');
});

test('کش هر کاربر جداست', async () => {
  const a = user(), b = user();
  await Sync.setScope(a);
  await Sync.saveCache({ customers: [{ name: 'محرمانه‌ی الف' }] });
  await Sync.setScope(b);
  assert.equal(await Sync.loadCache(), null);
  await Sync.setScope(a);
  assert.deepEqual((await Sync.loadCache()).customers[0].name, 'محرمانه‌ی الف');
});

test('خطای موقت سرور (۵۰۰، ۵۰۳، ۴۲۹، ۴۰۸) هیچ عملیاتی را حذف نمی‌کند و ترتیب را نگه می‌دارد', async () => {
  for (const status of [500, 503, 429, 408]) {
    reset();
    const u = user();
    await Sync.setScope(u);
    responder = () => { throw netErr(); };
    await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'اول' });
    await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'دوم' });
    calls.length = 0;
    responder = (m, p, body) => {
      if (body && body.name === 'اول') throw err(status, 'موقت');
      return {};
    };
    const res = await Sync.flush();
    assert.equal(res.retry, true, `status ${status}`);
    assert.equal(res.rejected, 0, `status ${status} نباید رد شود`);
    assert.equal(await Sync.pendingCount(), 2, `status ${status}: هر دو عملیات باید بمانند`);
    assert.deepEqual(calls.map((c) => c.body.name), ['اول'], 'بعد از خطای موقت ارسال متوقف می‌شود');
  }
});

test('نبود اتصال و ۴۰۱: صف دست‌نخورده، ۴۰۱ نشست را متوقف می‌کند', async () => {
  reset();
  const u = user();
  await Sync.setScope(u);
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/staff', { id: Sync.uuid(), name: 'ک' });
  responder = () => { throw netErr(); };
  assert.equal((await Sync.flush()).offline, true);
  assert.equal(await Sync.pendingCount(), 1);

  responder = () => { throw err(401, 'ورود لازم است'); };
  const res = await Sync.flush();
  assert.equal(res.auth, true);
  assert.equal(await Sync.pendingCount(), 1, 'با ۴۰۱ صف حذف نمی‌شود');
});

test('خطای دائمی (۴۰۰) عملیات را به فهرست ردشده می‌برد و بقیه ادامه می‌یابند', async () => {
  reset();
  const u = user();
  await Sync.setScope(u);
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'نامعتبر' });
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'درست' });
  responder = (m, p, body) => { if (body.name === 'نامعتبر') throw err(400, 'شماره نامعتبر'); return {}; };
  const res = await Sync.flush();
  assert.equal(res.rejected, 1);
  assert.equal(res.sent, 1);
  assert.equal(res.retry, false);
  assert.equal(await Sync.pendingCount(), 0);
  const rej = await Sync.rejectedOps();
  assert.equal(rej.length, 1);
  assert.equal(rej[0].reason, 'شماره نامعتبر');
});

test('تلاش مجدد عملیات ردشده با همان شناسه؛ حذف دائمی فقط با درخواست صریح', async () => {
  reset();
  const u = user();
  await Sync.setScope(u);
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: 'id-ثابت', name: 'دوباره' });
  responder = () => { throw err(400, 'موقتاً نامعتبر'); };
  await Sync.flush();
  const [rej] = await Sync.rejectedOps();
  assert.ok(rej);

  assert.equal(await Sync.retryRejected(rej.opId), true);
  assert.equal(await Sync.pendingCount(), 1);
  assert.equal((await Sync.rejectedOps()).length, 0);
  assert.equal((await Sync.pendingOps())[0].body.id, 'id-ثابت');

  await Sync.flush(); // دوباره رد می‌شود
  const [again] = await Sync.rejectedOps();
  assert.equal(await Sync.discardRejected(again.opId), true);
  assert.equal((await Sync.rejectedOps()).length, 0);
});

test('۴۰۴ برای حذف یا تغییر وضعیت یعنی انجام‌شده؛ ۴۰۴ برای ساخت، رد می‌شود', async () => {
  reset();
  const u = user();
  await Sync.setScope(u);
  responder = () => { throw netErr(); };
  await Sync.send('DELETE', '/transactions/t1');
  await Sync.send('POST', '/orders/o1/status', { to: 'ready' });
  responder = () => { throw err(404, 'نیست'); };
  const res = await Sync.flush();
  assert.equal(res.sent, 2);
  assert.equal(res.rejected, 0);
  assert.equal(await Sync.pendingCount(), 0);
});

test('خروج صف را پاک نمی‌کند؛ نشانه‌ی کاربر پاک می‌شود و ورود دوباره‌ی همان کاربر ارسال می‌کند', async () => {
  reset();
  const u = user();
  await Sync.setScope(u);
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'ماند' });
  await Sync.clearScope();
  assert.equal(await Sync.lastScope(), null);
  assert.equal(await Sync.pendingCount(), 0, 'بدون نشست، صف دیده نمی‌شود');

  await Sync.setScope(u);
  assert.equal(await Sync.pendingCount(), 1, 'صف کاربر پس از ورود مجدد باقی است');
  assert.equal(await Sync.lastScope(), u);
});

test('بدون نشست هیچ درخواستی ارسال نمی‌شود و نوشتن آفلاین خطا می‌دهد', async () => {
  reset();
  await Sync.clearScope();
  assert.equal((await Sync.flush()).sent, 0);
  assert.equal(calls.length, 0);
  responder = () => { throw netErr(); };
  await assert.rejects(Sync.send('POST', '/customers', { name: 'x' }));
});
