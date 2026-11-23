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

const err = (status, message = 'خطا', code = null) => Object.assign(new Error(message), { status, code });
const netErr = () => err(0, 'network');
const reset = () => { calls.length = 0; responder = null; };
let uid = 0;
const user = () => `user-${++uid}`; // هر تست کاربر جدا دارد، پس حالت مشترک بین تست‌ها مزاحم نیست

test('تغییر بدون اتصال در صف همان کاربر می‌ماند و با اتصال ارسال می‌شود', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
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
  await Sync.beginSession(a);
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'فقط برای الف' });

  await Sync.beginSession(b);
  assert.equal(await Sync.pendingCount(), 0);
  calls.length = 0; // فراخوانی ارسال اولیه‌ی کاربر الف را کنار می‌گذاریم
  responder = null;
  const res = await Sync.flush();
  assert.equal(res.sent, 0);
  assert.equal(calls.length, 0, 'کاربر ب هیچ درخواستی نباید بفرستد');

  await Sync.beginSession(a);
  assert.equal(await Sync.pendingCount(), 1, 'صف کاربر الف دست‌نخورده است');
});

test('کش هر کاربر جداست', async () => {
  const a = user(), b = user();
  await Sync.beginSession(a);
  await Sync.saveCache({ customers: [{ name: 'محرمانه‌ی الف' }] });
  await Sync.beginSession(b);
  assert.equal(await Sync.loadCache(), null);
  await Sync.beginSession(a);
  assert.deepEqual((await Sync.loadCache()).customers[0].name, 'محرمانه‌ی الف');
});

test('خطای موقت سرور (۵۰۰، ۵۰۳، ۴۲۹، ۴۰۸) هیچ عملیاتی را حذف نمی‌کند و ترتیب را نگه می‌دارد', async () => {
  for (const status of [500, 503, 429, 408]) {
    reset();
    const u = user();
    await Sync.beginSession(u);
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
  await Sync.beginSession(u);
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
  await Sync.beginSession(u);
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
  await Sync.beginSession(u);
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
  await Sync.beginSession(u);
  responder = () => { throw netErr(); };
  await Sync.send('DELETE', '/transactions/t1');
  await Sync.send('POST', '/orders/o1/status', { to: 'ready' });
  responder = () => { throw err(404, 'نیست'); };
  const res = await Sync.flush();
  assert.equal(res.sent, 2);
  assert.equal(res.rejected, 0);
  assert.equal(await Sync.pendingCount(), 0);
});

test('پایان نشست بدون خروج، صف را نگه می‌دارد و نشانه‌ی کاربر را پاک می‌کند', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'ماند' });
  await Sync.endSession();
  assert.equal(await Sync.lastScope(), null);
  assert.equal(await Sync.pendingCount(), 0, 'بدون نشست، صف دیده نمی‌شود');

  await Sync.beginSession(u);
  assert.equal(await Sync.pendingCount(), 1, 'صف کاربر پس از ورود مجدد باقی است');
  assert.equal(await Sync.lastScope(), u);
});

test('بدون نشست هیچ درخواستی ارسال نمی‌شود و نوشتن آفلاین خطا می‌دهد', async () => {
  reset();
  await Sync.endSession();
  assert.equal((await Sync.flush()).sent, 0);
  assert.equal(calls.length, 0);
  responder = () => { throw netErr(); };
  await assert.rejects(Sync.send('POST', '/customers', { name: 'x' }));
});

/* ---------- خروج: آفلاین، ترتیب، جداسازی ---------- */

test('خروج بعد از همه‌ی تغییرات کاربر ارسال می‌شود و ثبت خروج پاک می‌شود', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'قبل از خروج' });
  await Sync.requestLogout();
  assert.equal(await Sync.pendingCount(), 1, 'خروج در شمارش تغییرات نیست');
  calls.length = 0;
  responder = null;
  const r = await Sync.flush();
  assert.equal(r.loggedOut, true);
  assert.deepEqual(calls.map((c) => c.path), ['/customers', '/auth/logout'], 'خروج باید آخر باشد');
  const s = await Sync.settleLogout(u, r);
  assert.equal(s.finished, true);
  assert.equal(await Sync.hasPendingLogout(u), false);
  assert.equal(await Sync.pendingCount(), 0);
});

test('خروج آفلاین: ثبت خروج و صف می‌مانند، کش نمایشی پاک می‌شود، و با اتصال تمام می‌شود', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  await Sync.saveCache({ customers: [{ name: 'محرمانه' }] });
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'هنوز نرفته' });
  await Sync.requestLogout();
  const r = await Sync.flush();
  assert.equal(r.offline, true);
  const s = await Sync.settleLogout(u, r);
  assert.equal(s.finished, false);
  assert.equal(await Sync.hasPendingLogout(u), true);
  assert.equal(await Sync.loadCache(), null, 'کش نمایشی باید پاک شود');
  assert.equal(await Sync.lastScope(), null, 'بوت آفلاین نباید این کاربر را نشان دهد');

  responder = null;
  const done = await Sync.finishPendingLogouts();
  const mine = done.find((d) => d.userId === u);
  assert.equal(mine.finished, true);
  assert.equal(await Sync.hasPendingLogout(u), false);
  assert.equal(Sync.currentUser(), u, 'finishPendingLogouts scope قبلی را برمی‌گرداند');
});

test('خروج با نشست نامعتبر (۴۰۱) تمام شده در نظر گرفته می‌شود و داده‌ی صف حفظ می‌شود', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'حفظ' });
  await Sync.requestLogout();
  responder = () => { throw err(401, 'ورود لازم است'); };
  const r = await Sync.flush();
  assert.equal(r.auth, true);
  const s = await Sync.settleLogout(u, r);
  assert.equal(s.finished, true);
  assert.equal(await Sync.pendingCount(), 1, 'داده‌ی ارسال‌نشده نباید حذف شود');
});

test('خطای موقت هنگام خروج: ثبت خروج می‌ماند و تمام نمی‌شود', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  await Sync.requestLogout();
  responder = () => { throw err(503, 'موقت'); };
  const r = await Sync.flush();
  assert.equal(r.retry, true);
  assert.equal((await Sync.settleLogout(u, r)).finished, false);
  assert.equal(await Sync.hasPendingLogout(u), true);
});

test('ورود جدید خروج قدیمی همان کاربر را حذف می‌کند تا نشست تازه باطل نشود', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  await Sync.requestLogout();
  await Sync.beginSession(u);
  assert.equal(await Sync.hasPendingLogout(u), false);
  responder = () => { throw netErr(); };
  calls.length = 0;
  const r = await Sync.flush();
  assert.equal(r.loggedOut, false);
  assert.equal(calls.some((c) => c.path === '/auth/logout'), false);
});

test('تسویه‌ی خروج یک کاربر، صف و کش کاربر دیگر را دست نمی‌زند', async () => {
  reset();
  const a = user(), b = user();
  await Sync.beginSession(b);
  await Sync.saveCache({ customers: [{ name: 'ب' }] });
  responder = () => { throw netErr(); };
  await Sync.send('POST', '/customers', { id: Sync.uuid(), name: 'برای ب' });
  await Sync.beginSession(a);
  await Sync.requestLogout();
  responder = () => { throw netErr(); };
  const r = await Sync.flush();
  await Sync.settleLogout(a, { ...r, loggedOut: true });
  await Sync.beginSession(b);
  assert.equal(await Sync.pendingCount(), 1);
  assert.deepEqual((await Sync.loadCache()).customers[0].name, 'ب');
});

/* ---------- کنترل نسخه‌ی وضعیت سفارش ---------- */

test('تعارض نسخه (۴۰۹) ردشده می‌شود، کد خطا را نگه می‌دارد و هرگز تکرار خودکار نمی‌شود', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  const orderId = Sync.uuid();
  responder = () => { throw netErr(); };
  await Sync.send('POST', `/orders/${orderId}/status`, { to: 'ready', version: 1 });
  responder = () => { throw err(409, 'وضعیت این سفارش هم‌زمان تغییر کرده است', 'version_conflict'); };
  const r = await Sync.flush();
  assert.equal(r.rejected, 1);
  assert.equal(r.retry, false);
  assert.equal(await Sync.pendingCount(), 0);
  const rec = (await Sync.rejectedOps())[0];
  assert.equal(rec.code, 'version_conflict');
  assert.equal(rec.body.version, 1, 'نسخه‌ی ارسال‌شده ثبت می‌ماند');
});

test('نسخه‌ی تغییر وضعیت بعدی = نسخه‌ی دیده‌شده + تغییرات وضعیت در صف همان سفارش', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  const orderId = Sync.uuid();
  assert.equal(await Sync.expectedStatusVersion(orderId, 3), 3, 'بدون تغییر در صف');
  responder = () => { throw netErr(); };
  await Sync.send('POST', `/orders/${orderId}/status`, { to: 'progress', version: 3 });
  await Sync.send('POST', `/orders/${orderId}/status`, { to: 'ready', version: 4 });
  await Sync.send('POST', `/orders/${Sync.uuid()}/status`, { to: 'ready', version: 1 });
  assert.equal(await Sync.expectedStatusVersion(orderId, 3), 5, 'دو تغییر در صف برای همین سفارش');
  assert.equal(await Sync.expectedStatusVersion(Sync.uuid(), undefined), 1, 'سفارش تازه (هنوز روی سرور نیست) نسخه‌ی ۱ دارد');
});

test('تلاش مجدد پس از بررسی: نسخه‌ی تازه جایگزین می‌شود و شناسه‌ی عملیات همان می‌ماند', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  const orderId = Sync.uuid();
  responder = () => { throw netErr(); };
  await Sync.send('POST', `/orders/${orderId}/status`, { to: 'progress', version: 1 });
  responder = () => { throw err(409, 'تعارض', 'version_conflict'); };
  await Sync.flush();
  const [rec] = await Sync.rejectedOps();
  assert.equal(await Sync.retryRejected(rec.opId, { version: 7 }), true);
  const [queued] = await Sync.pendingOps();
  assert.equal(queued.opId, rec.opId);
  assert.equal(queued.body.version, 7);
  assert.equal(queued.body.to, 'progress', 'وضعیت مقصد تغییر نمی‌کند');
  assert.equal(await Sync.rejectedOp(rec.opId), null);
});

test('خروج ارسال شده اما ثبتش تسویه نشده (صفحه پیش از تسویه بسته شد): تسویه‌ی بعدی آن را پاک می‌کند', async () => {
  reset();
  const u = user();
  await Sync.beginSession(u);
  await Sync.requestLogout();
  responder = null;
  const r = await Sync.flush(); // خروج ارسال می‌شود؛ settleLogout اجرا نمی‌شود
  assert.equal(r.loggedOut, true);
  assert.equal(await Sync.pendingCount(), 0);
  assert.equal(await Sync.hasPendingLogout(u), true, 'ثبت هنوز مانده است');
  const done = await Sync.finishPendingLogouts();
  assert.equal(done.find((d) => d.userId === u).finished, true);
  assert.equal(await Sync.hasPendingLogout(u), false);
});

test('تأخیر تلاش مجدد: ۳۰ ثانیه، دو برابر شدن، سقف ۵ دقیقه', () => {
  assert.equal(Sync.retryDelay(0), 30000);
  assert.equal(Sync.retryDelay(1), 60000);
  assert.equal(Sync.retryDelay(2), 120000);
  assert.equal(Sync.retryDelay(3), 240000);
  assert.equal(Sync.retryDelay(4), 300000, 'سقف ۵ دقیقه');
  assert.equal(Sync.retryDelay(50), 300000, 'شمارنده‌ی بزرگ هم از سقف نمی‌گذرد');
  assert.equal(Sync.retryDelay(-3), 30000, 'مقدار نامعتبر به پایه برمی‌گردد');
  assert.equal(Sync.retryDelay(NaN), 30000);
});
