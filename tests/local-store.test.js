// آزمون‌های واحد ذخیره‌سازی رمزشده‌ی حالت محلی (js/local-store.js).
// localStorage با یک انبار ساختگی و کلید با حافظه‌ی داخلی (بدون IndexedDB) شبیه‌سازی می‌شود.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
require("../js/local-store.js");

const LS = globalThis.LocalStore;
const { V2_KEY, V3_KEY, BACKUP_KEY } = LS;

function fakeStorage(extra = {}) {
  const map = new Map(Object.entries(extra));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const seed = () => ({
  orders: [],
  customers: [{ name: "نمونه", phone: "", note: "" }],
  staff: [],
  transactions: [],
  settings: { shopName: "مزون نمونه", ownerName: "", phone: "", address: "", currency: "تومان" },
});

const legacyState = (name) => ({
  orders: [],
  customers: [{ name, phone: "09120000000", note: "یادداشت-" + name }],
  staff: [],
  transactions: [],
  settings: { shopName: "مزون قدیمی", ownerName: "", phone: "", address: "", currency: "تومان" },
});

async function startWith(storage, target = {}) {
  for (const k of Object.keys(target)) delete target[k];
  const st = await LS.init({ storage, target, seed });
  return { st, target };
}

beforeEach(() => LS.testing.reset());

test('راه‌اندازی تازه: نمونه، بدون نوشتن و بدون قفل', async () => {
  const storage = fakeStorage();
  const { st, target } = await startWith(storage);
  assert.equal(st.ready, true);
  assert.equal(st.locked, false);
  assert.equal(target.customers[0].name, 'نمونه');
  assert.equal(storage.map.has(V3_KEY), false, 'بدون تغییر چیزی نوشته نمی‌شود');
});

test('ذخیره و خواندن دوباره: متن ساده در انبار نیست و داده برمی‌گردد', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  target.customers = [{ name: 'مریم-محرمانه', phone: '09121112233', note: 'یادداشت-محرمانه' }];
  assert.equal(LS.save(target), true);
  await LS.flush();
  const raw = storage.map.get(V3_KEY);
  assert.ok(raw, 'پاکت رمزشده نوشته شده');
  assert.equal(raw.includes('مریم-محرمانه'), false);
  assert.equal(raw.includes('09121112233'), false);
  assert.equal(raw.includes('یادداشت-محرمانه'), false);

  LS.testing.reset();
  const { st, target: again } = await startWith(storage);
  assert.equal(st.ready, true);
  assert.equal(again.customers[0].name, 'مریم-محرمانه');
  assert.equal(again.customers[0].note, 'یادداشت-محرمانه');
});

test('مهاجرت: داده‌ی ساده‌ی قدیمی رمز می‌شود و نسخه‌ی ساده فقط بعد از تأیید حذف می‌شود', async () => {
  const storage = fakeStorage({ [V2_KEY]: JSON.stringify(legacyState('مشتری-قدیمی')) });
  const { st, target } = await startWith(storage);
  assert.equal(st.ready, true);
  assert.equal(st.migrationPending, false);
  assert.equal(target.customers[0].name, 'مشتری-قدیمی', 'همه‌ی رکوردها حفظ می‌شوند');
  assert.equal(storage.map.has(V2_KEY), false, 'نسخه‌ی ساده پس از تأیید حذف شد');
  assert.equal(storage.map.get(V3_KEY).includes('مشتری-قدیمی'), false);

  LS.testing.reset();
  const again = await startWith(storage);
  assert.equal(again.target.customers[0].note, 'یادداشت-مشتری-قدیمی', 'داده‌ی کامل بعد از راه‌اندازی دوباره');
});

test('مهاجرت با خطای نوشتن: نسخه‌ی ساده دست‌نخورده می‌ماند و داده در حافظه هست', async () => {
  const storage = fakeStorage({ [V2_KEY]: JSON.stringify(legacyState('ایمن-بماند')) });
  const realSet = storage.setItem;
  storage.setItem = (k, v) => { if (k === V3_KEY) throw new Error('quota'); return realSet(k, v); };
  const { st, target } = await startWith(storage);
  assert.equal(st.ready, true);
  assert.equal(st.migrationPending, true);
  assert.equal(target.customers[0].name, 'ایمن-بماند');
  assert.ok(storage.map.has(V2_KEY), 'نسخه‌ی ساده نباید حذف شود');
  assert.equal(storage.map.has(V3_KEY), false);
});

test('نسخه‌ی ساده‌ی یکسان با رمزشده حذف می‌شود؛ نسخه‌ی متفاوت دست‌نخورده می‌ماند', async () => {
  // حالت ۱: نسخه‌ی ساده‌ی یکسان بعد از مهاجرت می‌ماند و در راه‌اندازی بعدی حذف می‌شود
  const same = fakeStorage({ [V2_KEY]: JSON.stringify(legacyState('یکسان')) });
  await startWith(same);
  assert.equal(same.map.has(V2_KEY), false);
  same.map.set(V2_KEY, JSON.stringify(legacyState('یکسان')));
  LS.testing.reset();
  const again = await startWith(same);
  assert.equal(again.st.staleLegacy, false);
  assert.equal(same.map.has(V2_KEY), false, 'نسخه‌ی یکسان حذف می‌شود');

  // حالت ۲: یک زبانه‌ی قدیمی نسخه‌ی ساده‌ی متفاوتی نوشته؛ هشدار و دست‌نخورده
  const storage2 = fakeStorage({ [V2_KEY]: JSON.stringify(legacyState('اول')) });
  await startWith(storage2);
  storage2.map.set(V2_KEY, JSON.stringify(legacyState('متفاوت')));
  LS.testing.reset();
  const st = (await startWith(storage2)).st;
  assert.equal(st.staleLegacy, true, 'نسخه‌ی ساده‌ی متفاوت هشدار می‌دهد');
  assert.ok(storage2.map.has(V2_KEY), 'و دست‌نخورده می‌ماند');
});

test('کلید گم شده با پاکت رمزشده: قفل، بدون نوشتن و بدون بازنویسی', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  target.customers = [{ name: 'قفل-شده', phone: '', note: '' }];
  LS.save(target); await LS.flush();
  const before = storage.map.get(V3_KEY);

  LS.testing.dropKey();
  LS.testing.reset();
  const st = (await startWith(storage)).st;
  assert.equal(st.locked, true);
  assert.equal(st.reason, 'key_missing');
  assert.equal(LS.save({ customers: [] }), false, 'نوشتن در حالت قفل انجام نمی‌شود');
  await LS.flush();
  assert.equal(storage.map.get(V3_KEY), before, 'پاکت دست‌نخورده است');
});

test('کلید گم شده: کلید تازه ساخته نمی‌شود (پاکت باقی مانده)', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  LS.save(target); await LS.flush();
  LS.testing.dropKey();
  LS.testing.reset();
  await startWith(storage);
  assert.equal(LS.getStatus().locked, true);
  // هیچ کلید تازه‌ای نباید ساخته شده باشد؛ تلاش برای نوشتن با پاکت باقی‌مانده هم رد می‌شود
  assert.equal(LS.save(target), false);
});

test('پاکت دستکاری‌شده: رمزگشایی شکست می‌خورد و قفل می‌شود', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  target.customers = [{ name: 'سالم', phone: '', note: '' }];
  LS.save(target); await LS.flush();
  const env = JSON.parse(storage.map.get(V3_KEY));
  const bytes = Buffer.from(env.ct, 'base64');
  bytes[0] ^= 0xff;
  env.ct = bytes.toString('base64');
  storage.map.set(V3_KEY, JSON.stringify(env));
  LS.testing.reset();
  const st = (await startWith(storage)).st;
  assert.equal(st.locked, true);
  assert.equal(st.reason, 'decrypt_failed');
});

test('پاکت خراب: قفل با دلیل corrupt و امکان حذف', async () => {
  const storage = fakeStorage({ [V3_KEY]: '{خراب' });
  const st = (await startWith(storage)).st;
  assert.equal(st.locked, true);
  assert.equal(st.reason, 'corrupt');
  await LS.deleteUnreadable();
  assert.equal(storage.map.has(V3_KEY), false);
});

test('حذف فقط داده‌ی ناخوانا: داده‌ی قابل‌خواندن و نسخه‌ی ساده حذف نمی‌شوند', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  LS.save(target); await LS.flush();
  // داده‌ی قابل‌خواندن: حذف باید رد شود
  LS.testing.reset();
  await startWith(storage);
  await assert.rejects(() => LS.deleteUnreadable(), /قابل‌خواندن/);
  assert.equal(storage.map.has(V3_KEY), true, 'داده‌ی قابل‌خواندن نباید حذف شود');
});

test('حذف پاکت ناخوانا دست‌نخورده‌ی نسخه‌ی ساده‌ی قدیمی را نگه می‌دارد', async () => {
  const storage = fakeStorage({ [V3_KEY]: '{خراب', [V2_KEY]: JSON.stringify(legacyState('ساده-بماند')) });
  const st = (await startWith(storage)).st;
  assert.equal(st.locked, true);
  await LS.deleteUnreadable();
  assert.equal(storage.map.has(V3_KEY), false);
  assert.ok(storage.map.has(V2_KEY), 'نسخه‌ی ساده نباید حذف شود');

  // بعد از حذف، راه‌اندازی دوباره داده‌ی ساده را مهاجرت می‌دهد
  LS.testing.reset();
  const again = await startWith(storage);
  assert.equal(again.st.ready, true);
  assert.equal(again.target.customers[0].name, 'ساده-بماند');
});

test('readPlain: رمزشده را باز می‌کند، ساده را می‌خواند و در حالت قفل null می‌دهد', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  target.customers = [{ name: 'برای-انتقال', phone: '', note: '' }];
  LS.save(target); await LS.flush();
  assert.equal((await LS.readPlain()).customers[0].name, 'برای-انتقال');

  LS.testing.dropKey();
  assert.equal(await LS.readPlain(), null, 'بدون کلید چیزی برای انتقال نیست');

  const plain = fakeStorage({ [V2_KEY]: JSON.stringify(legacyState('ساده-انتقال')) });
  LS.testing.reset();
  await startWith(fakeStorage());
  const storage2 = fakeStorage({ [V2_KEY]: JSON.stringify(legacyState('ساده-انتقال')) });
  LS.testing.reset();
  // راه‌اندازی بدون مهاجرت (target=null) فقط برای خواندن
  await LS.init({ storage: storage2, target: null, seed });
  assert.equal((await LS.readPlain()).customers[0].name, 'ساده-انتقال');
});

test('نوشتن‌های پشت‌سرهم: ترتیب حفظ می‌شود و آخرین حالت ذخیره می‌شود', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  for (let i = 0; i < 25; i += 1) {
    target.customers = [{ name: 'تغییر-' + i, phone: '', note: '' }];
    LS.save(target);
  }
  await LS.flush();
  LS.testing.reset();
  const again = await startWith(storage);
  assert.equal(again.target.customers[0].name, 'تغییر-24');
});

test('قبل از راه‌اندازی نوشتن انجام نمی‌شود', () => {
  LS.testing.reset();
  assert.equal(LS.save({ customers: [] }), false);
  assert.equal(LS.isReady(), false);
});

test('شمارش نوشتن‌های در انتظار: همزمان با ذخیره بالا می‌رود و بعد از نوشتن به صفر برمی‌گردد', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  assert.equal(LS.pendingCount(), 0);
  LS.save(target);
  assert.equal(LS.pendingCount(), 1, 'بلافاصله بعد از ذخیره در انتظار است');
  LS.save(target);
  LS.save(target);
  assert.equal(LS.pendingCount(), 3);
  await LS.flush();
  assert.equal(LS.pendingCount(), 0, 'بعد از تکمیل همه‌ی نوشتن‌ها صفر است');
});

test('بسته شدن صفحه وسط نوشتن: آخرین تغییر ناتمام است ولی پاکت قبلی سالم و کامل می‌ماند', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  target.customers = [{ name: 'حالت-الف', phone: '', note: '' }];
  LS.save(target);
  await LS.flush();

  target.customers = [{ name: 'حالت-ب-ناتمام', phone: '', note: '' }];
  LS.save(target); // هنوز نوشته نشده
  LS.testing.reset(); // بارگذاری مجدد: نسل قبلی دیگر نمی‌نویسد

  await LS.flush();
  const env = JSON.parse(storage.map.get(V3_KEY));
  assert.ok(env && env.ct, 'پاکت کامل است و نیمه‌نوشته نیست');
  const again = await startWith(storage);
  assert.equal(again.st.locked, false);
  assert.equal(again.target.customers[0].name, 'حالت-الف', 'آخرین نوشتن کامل‌شده برگشته است');
});

test('شکست نوشتن روی انبار: پاکت قبلی دست‌نخورده می‌ماند و خطا گزارش می‌شود', async () => {
  const storage = fakeStorage();
  let errors = 0;
  await LS.init({ storage, target: {}, seed, onError: () => { errors += 1; } });
  const state = seed();
  state.customers = [{ name: 'سالم', phone: '', note: '' }];
  LS.save(state); await LS.flush();
  const good = storage.map.get(V3_KEY);

  const realSet = storage.setItem;
  storage.setItem = (k, v) => { if (k === V3_KEY) throw new Error('quota'); return realSet(k, v); };
  state.customers = [{ name: 'ناموفق', phone: '', note: '' }];
  LS.save(state); await LS.flush();
  assert.equal(errors, 1, 'خطا یک بار گزارش شد');
  assert.equal(storage.map.get(V3_KEY), good, 'پاکت سالم قبلی نباید آسیب ببیند');
  assert.equal(LS.pendingCount(), 0);
});

test('نوشتن‌های سریع پشت‌سرهم: شمارش درست و آخرین وضعیت ذخیره می‌شود', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  for (let i = 0; i < 40; i += 1) {
    target.customers = [{ name: 'سریع-' + i, phone: '', note: '' }];
    LS.save(target);
  }
  assert.equal(LS.pendingCount(), 40);
  await LS.flush();
  assert.equal(LS.pendingCount(), 0);
  LS.testing.reset();
  const again = await startWith(storage);
  assert.equal(again.target.customers[0].name, 'سریع-39');
});

test('راه‌اندازی تازه: کلید پیش از اولین نوشتن ساخته می‌شود و نوشتن اول کامل می‌شود', async () => {
  const storage = fakeStorage();
  await startWith(storage);
  const st = LS.getStatus();
  assert.equal(st.ready, true);
  const { target } = await startWith(storage);
  target.customers = [{ name: 'اولین', phone: '', note: '' }];
  LS.save(target);
  await LS.flush();
  LS.testing.reset();
  const again = await startWith(storage);
  assert.equal(again.target.customers[0].name, 'اولین');
});

test('خطای IndexedDB هنگام راه‌اندازی: قفل با دلیل vault_unavailable، پاکت دست‌نخورده و بدون امکان حذف', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  target.customers = [{ name: 'سالم-نجات', phone: '', note: '' }];
  LS.save(target); await LS.flush();
  const sealed = storage.map.get(V3_KEY);

  LS.testing.reset();
  LS.testing.setVaultFailure(true);
  const st = (await startWith(storage)).st;
  assert.equal(st.locked, true);
  assert.equal(st.reason, 'vault_unavailable', 'خطای دسترسی کلید «کلید گم شده» نیست');
  assert.equal(storage.map.get(V3_KEY), sealed, 'پاکت سالم دست‌نخورده است');
  await assert.rejects(() => LS.deleteUnreadable(), /هیچ‌چیز حذف نشد/);
  assert.equal(storage.map.get(V3_KEY), sealed, 'حذف در خطای موقت انجام نشد');

  // بعد از برگشت دسترسی، داده همان است که بود
  LS.testing.reset();
  const again = await startWith(storage);
  assert.equal(again.st.locked, false);
  assert.equal(again.target.customers[0].name, 'سالم-نجات');
});

test('خطای IndexedDB هنگام نوشتن: هیچ پاکتی بدون کلید پایدار نوشته نمی‌شود و بعد از برگشت دسترسی ذخیره می‌شود', async () => {
  const storage = fakeStorage();
  let errors = 0;
  await LS.init({ storage, target: {}, seed, onError: () => { errors += 1; } });
  LS.testing.setVaultFailure(true);
  const state = seed();
  state.customers = [{ name: 'در-زمان-خطا', phone: '', note: '' }];
  LS.save(state); await LS.flush();
  assert.equal(errors, 1, 'خطا گزارش شد');
  assert.equal(storage.map.get(V3_KEY), undefined, 'بدون کلید پایدار، پاکت با کلید موقت نوشته نمی‌شود');

  LS.testing.setVaultFailure(false);
  LS.save(state); await LS.flush();
  LS.testing.reset();
  const again = await startWith(storage);
  assert.equal(again.target.customers[0].name, 'در-زمان-خطا');
});

/* ---------- حالت فقط‌نشست (بدون IndexedDB) ---------- */

test('بدون IndexedDB: حالت فقط‌نشست؛ هیچ پاکتی نوشته نمی‌شود و داده در همان صفحه کار می‌کند', async () => {
  LS.testing.setVaultMode('none');
  const storage = fakeStorage();
  const { st, target } = await startWith(storage);
  assert.equal(st.ready, true);
  assert.equal(st.persistent, false);
  assert.equal(st.sessionOnly, true);
  target.customers = [{ name: 'فقط-این-صفحه', phone: '', note: '' }];
  assert.equal(LS.save(target), true, 'تغییر در حافظه‌ی صفحه پذیرفته می‌شود');
  await LS.flush();
  assert.equal(storage.map.has(V3_KEY), false, 'هیچ پاکت رمزشده‌ای نوشته نشده');
  assert.equal(storage.map.has(V2_KEY), false, 'و هیچ نسخه‌ی ساده‌ای ساخته نشده');
  assert.equal(LS.getStatus().sessionDirty, true, 'تغییر بدون ذخیره‌ی دائمی ثبت شده');
});

test('بدون IndexedDB و با نسخه‌ی ساده‌ی قدیمی: داده خوانده می‌شود، v2 دست‌نخورده می‌ماند', async () => {
  LS.testing.setVaultMode('none');
  const storage = fakeStorage({ [V2_KEY]: JSON.stringify(legacyState('قدیمی-بماند')) });
  const { st, target } = await startWith(storage);
  assert.equal(target.customers[0].name, 'قدیمی-بماند');
  assert.equal(st.legacyKept, true);
  target.customers = [];
  LS.save(target); await LS.flush();
  assert.equal(storage.map.get(V2_KEY), JSON.stringify(legacyState('قدیمی-بماند')), 'نسخه‌ی ساده تغییر نکرده');
  assert.equal(storage.map.has(V3_KEY), false);
});

test('بدون IndexedDB و با پاکت رمزشده: قفل بدون امکان حذف و بدون تغییر', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  target.customers = [{ name: 'سالم', phone: '', note: '' }];
  LS.save(target); await LS.flush();
  const sealed = storage.map.get(V3_KEY);

  LS.testing.reset();
  LS.testing.setVaultMode('none');
  const st = (await startWith(storage)).st;
  assert.equal(st.locked, true);
  assert.equal(st.reason, 'no_vault');
  await assert.rejects(() => LS.deleteUnreadable(), /هیچ‌چیز حذف نشد/);
  assert.equal(storage.map.get(V3_KEY), sealed);
});

/* ---------- بازیابی داده‌ی نسخه‌ی قدیمی ---------- */

// وضعیت واقعی: داده‌ی جدیدتر رمزشده است و یک زبانه‌ی قدیمی بعد از مهاجرت یک نسخه‌ی ساده نوشته است
async function staleScenario() {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  target.customers = [{ name: 'جدید-رمزشده', phone: '09120000001', note: 'جدیدترین' }];
  target.orders = [{ id: 'o1', customer: 'جدید-رمزشده' }];
  LS.save(target); await LS.flush();
  const newer = storage.map.get(V3_KEY);
  storage.map.set(V2_KEY, JSON.stringify(legacyState('قدیمی-از-زبانه')));
  LS.testing.reset();
  const again = await startWith(storage);
  return { storage, target: again.target, st: again.st, newer };
}

test('پنل بازیابی: شمارش داده‌ی فعلی و نسخه‌ی قدیمی را نشان می‌دهد و چیزی را تغییر نمی‌دهد', async () => {
  const { storage, newer } = await staleScenario();
  const info = LS.recoveryInfo();
  assert.equal(info.legacyPresent, true);
  assert.deepEqual(info.currentCounts, { customers: 1, orders: 1, staff: 0, transactions: 0 });
  assert.deepEqual(info.legacyCounts, { customers: 1, orders: 0, staff: 0, transactions: 0 });
  assert.equal(info.backupExists, false);
  assert.equal(storage.map.get(V3_KEY), newer);
});

test('ورود داده‌ی قدیمی: داده‌ی جدیدتر پیش از هر تغییری در پشتیبان رمزشده می‌ماند و هیچ‌چیز حذف نمی‌شود', async () => {
  const { storage, target, newer } = await staleScenario();
  const counts = await LS.importLegacy();
  assert.deepEqual(counts, { customers: 1, orders: 0, staff: 0, transactions: 0 });
  assert.equal(target.customers[0].name, 'قدیمی-از-زبانه');
  assert.equal(storage.map.has(V2_KEY), false, 'نسخه‌ی ساده فقط بعد از تأیید حذف شد');
  assert.ok(storage.map.get(BACKUP_KEY), 'پشتیبان داده‌ی جدیدتر وجود دارد');
  assert.equal(storage.map.get(BACKUP_KEY).includes('جدید-رمزشده'), false, 'پشتیبان رمزشده است');
  assert.notEqual(storage.map.get(V3_KEY), newer, 'داده‌ی اصلی جایگزین شده');

  // داده‌ی جدیدتر از پشتیبان قابل بازیابی است
  const bak = JSON.parse(await LS.testing.openAny(storage.map.get(BACKUP_KEY), 'dokhtyar.local.backup'));
  assert.equal(bak.customers[0].name, 'جدید-رمزشده');
  assert.equal(bak.orders.length, 1, 'سفارش جدیدتر هم در پشتیبان است');
});

test('ورود داده‌ی قدیمی: با وجود پشتیبان قبلی انجام نمی‌شود و هیچ‌چیز تغییر نمی‌کند', async () => {
  const { storage, target } = await staleScenario();
  await LS.importLegacy();
  // دوباره یک نسخه‌ی ساده‌ی تازه می‌گذاریم
  storage.map.set(V2_KEY, JSON.stringify(legacyState('سومی')));
  const v3 = storage.map.get(V3_KEY), bak = storage.map.get(BACKUP_KEY);
  await assert.rejects(() => LS.importLegacy(), /پشتیبان قبلی/);
  assert.equal(storage.map.get(V3_KEY), v3);
  assert.equal(storage.map.get(BACKUP_KEY), bak);
  assert.equal(target.customers[0].name, 'قدیمی-از-زبانه');
});

test('ورود داده‌ی قدیمی: اگر پشتیبان تأیید نشود، داده‌ی فعلی و نسخه‌ی ساده دست‌نخورده می‌مانند', async () => {
  const { storage, target, newer } = await staleScenario();
  const v2 = storage.map.get(V2_KEY);
  const realSet = storage.setItem;
  storage.setItem = (k, v) => realSet(k, k === BACKUP_KEY ? 'خراب' : v);
  await assert.rejects(() => LS.importLegacy(), /دست‌نخورده/);
  storage.setItem = realSet;
  assert.equal(storage.map.get(V3_KEY), newer, 'داده‌ی فعلی همان است');
  assert.equal(storage.map.has(BACKUP_KEY), false, 'پشتیبان ناقص پاک شد');
  assert.equal(storage.map.get(V2_KEY), v2, 'نسخه‌ی ساده مانده');
  assert.equal(target.customers[0].name, 'جدید-رمزشده');
});

test('ورود داده‌ی قدیمی: اگر نوشتن داده‌ی جدید شکست بخورد، برگشت کامل انجام می‌شود', async () => {
  const { storage, target, newer } = await staleScenario();
  const v2 = storage.map.get(V2_KEY);
  const realSet = storage.setItem;
  let v3Writes = 0;
  storage.setItem = (k, v) => {
    if (k === V3_KEY && v3Writes++ === 0) throw new Error('quota');
    return realSet(k, v);
  };
  await assert.rejects(() => LS.importLegacy(), /دست‌نخورده/);
  storage.setItem = realSet;
  assert.equal(storage.map.get(V3_KEY), newer);
  assert.equal(storage.map.has(BACKUP_KEY), false);
  assert.equal(storage.map.get(V2_KEY), v2);
  assert.equal(target.customers[0].name, 'جدید-رمزشده');
});

test('ورود داده‌ی قدیمی: نوشتن‌های در انتظار قبل از بازیابی ذخیره می‌شوند و در پشتیبان هستند', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  // یک زبانه‌ی قدیمی بعد از راه‌اندازی نسخه‌ی ساده نوشته است
  storage.map.set(V2_KEY, JSON.stringify(legacyState('ورود-بعد-از-تغییر')));
  // تغییری که هنوز ذخیره نشده
  target.customers = [{ name: 'تازه-در-انتظار', phone: '', note: '' }];
  LS.save(target);
  await LS.importLegacy();
  const bak = JSON.parse(await LS.testing.openAny(storage.map.get(BACKUP_KEY), 'dokhtyar.local.backup'));
  assert.equal(bak.customers[0].name, 'تازه-در-انتظار', 'تغییر در انتظار در پشتیبان ماند');
});

test('جابه‌جایی: بازگشت به داده‌ی جدیدتر و دوباره به قدیمی؛ هیچ‌چیز حذف نمی‌شود', async () => {
  const { storage, target } = await staleScenario();
  await LS.importLegacy();
  const after = await LS.swapWithBackup();
  assert.deepEqual(after, { customers: 1, orders: 1, staff: 0, transactions: 0 });
  assert.equal(target.customers[0].name, 'جدید-رمزشده');
  assert.ok(storage.map.get(BACKUP_KEY), 'پشتیبان هنوز هست');
  await LS.swapWithBackup();
  assert.equal(target.customers[0].name, 'قدیمی-از-زبانه', 'جابه‌جایی دوباره برگرداند');

  LS.testing.reset();
  const again = await startWith(storage);
  assert.equal(again.target.customers[0].name, 'قدیمی-از-زبانه', 'بعد از بارگذاری هم درست است');
});

test('جابه‌جایی بدون پشتیبان: خطا و هیچ تغییری', async () => {
  const storage = fakeStorage();
  await startWith(storage);
  await assert.rejects(() => LS.swapWithBackup(), /پشتیبانی برای جابه‌جایی/);
});

/* ---------- نشانگر وضعیت نوشتن ---------- */

test('نشانگر: «در حال ذخیره» همزمان با ذخیره، و «ذخیره شد» فقط بعد از بازخوانی موفق', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  const seen = [];
  const stop = LS.subscribe((s) => seen.push(s.state));
  assert.deepEqual(seen, ['idle'], 'وضعیت فعلی فوراً گزارش می‌شود');
  target.customers = [{ name: 'نشانگر', phone: '', note: '' }];
  LS.save(target);
  assert.equal(LS.getWriteStatus().state, 'saving', 'بلافاصله بعد از ذخیره در حال ذخیره است');
  await LS.flush();
  assert.equal(LS.getWriteStatus().state, 'saved');
  assert.ok(LS.getWriteStatus().lastSavedAt > 0);
  assert.deepEqual(seen, ['idle', 'saving', 'saved']);
  stop();
});

test('نشانگر: اگر بازخوانی تأیید نشود «ذخیره شد» گزارش نمی‌شود و خطا نشان داده می‌شود', async () => {
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  const seen = [];
  LS.subscribe((s) => seen.push(s));
  const realSet = storage.setItem;
  storage.setItem = (k, v) => realSet(k, k === V3_KEY ? 'نوشته-نشده' : v); // نوشتن بی‌صدا ناقص
  target.customers = [{ name: 'ناتمام', phone: '', note: '' }];
  LS.save(target);
  await LS.flush();
  storage.setItem = realSet;
  const states = seen.map((s) => s.state);
  assert.equal(states.includes('saved'), false, '«ذخیره شد» هرگز پیش از تأیید نشان داده نمی‌شود');
  assert.equal(LS.getWriteStatus().state, 'error');
  assert.match(LS.getWriteStatus().error, /ذخیره نشد/);

  // نوشتن بعدی موفق باشد، وضعیت خطا پاک می‌شود
  LS.save(target);
  await LS.flush();
  assert.equal(LS.getWriteStatus().state, 'saved');
  assert.equal(LS.getWriteStatus().error, null);
});

test('نشانگر: در حالت فقط‌نشست هرگز «ذخیره شد» گزارش نمی‌شود', async () => {
  LS.testing.setVaultMode('none');
  const storage = fakeStorage();
  const { target } = await startWith(storage);
  target.customers = [{ name: 'موقت', phone: '', note: '' }];
  LS.save(target);
  await LS.flush();
  assert.equal(LS.getWriteStatus().state, 'session');
});

test('نشانگر: در حین بازیابی وضعیت «بازیابی» است و بعدش «ذخیره شد»', async () => {
  const { storage } = await staleScenario();
  const seen = [];
  LS.subscribe((s) => seen.push(s.state));
  await LS.importLegacy();
  assert.ok(seen.includes('busy'), 'در حین بازیابی وضعیت busy گزارش شد');
  assert.equal(LS.getWriteStatus().state, 'saved');
  void storage;
});

// ---------- شکست نوشتن در میانه‌ی ورود و جابه‌جایی ----------
// انبار ساختگی که نوشتن‌ها را فقط وقتی کنترل شده شکست می‌دهد: نوشتن k‌ام، یا نوشتن از k‌ام به بعد (برگشت هم شکست می‌خورد).
function armable(base) {
  const ctl = { armed: false, failAt: 0, failAll: false, n: 0 };
  const storage = {
    map: base.map,
    getItem: base.getItem,
    removeItem: base.removeItem,
    setItem(k, v) {
      if (ctl.armed) {
        ctl.n += 1;
        if (ctl.n === ctl.failAt || (ctl.failAll && ctl.n >= ctl.failAt)) throw new Error("نوشتن شکست خورد (آزمون)");
      }
      base.setItem(k, v);
    },
  };
  return { storage, ctl };
}

// آیا داده‌ی با این نام هنوز در یکی از انبارها قابل خواندن است؟ (ساده، رمزشده‌ی اصلی، پشتیبان، موقت)
async function recoverable(map, name) {
  const plain = map.get(V2_KEY);
  if (plain) { try { if (JSON.parse(plain).customers[0].name === name) return true; } catch (e) { /* ادامه */ } }
  for (const [key, aad] of [[V3_KEY, 'dokhtyar.local.v3'], [BACKUP_KEY, 'dokhtyar.local.backup'], [LS.SWAP_KEY, 'dokhtyar.local.swap']]) {
    const env = map.get(key);
    if (!env) continue;
    try {
      if (JSON.parse(await LS.testing.openAny(env, aad)).customers[0].name === name) return true;
    } catch (e) { /* این انبار خوانا نیست؛ بقیه را بررسی کن */ }
  }
  return false;
}

// وضعیت شروع: داده‌ی فعلی «جدید» در رمزشده، و نسخه‌ی ساده‌ی قدیمی «قدیمی» که هنوز وارد نشده
async function armedStart() {
  const base = fakeStorage();
  const { storage, ctl } = armable(base);
  const { target } = await startWith(storage);
  target.customers = [{ name: 'جدید-آزمون', phone: '', note: '' }];
  LS.save(target); await LS.flush();
  base.map.set(V2_KEY, JSON.stringify(legacyState('قدیمی-آزمون')));
  LS.testing.reset();
  const again = await startWith(storage);
  return { base, ctl, target: again.target };
}

for (const failAll of [false, true]) {
  test(`ورود داده‌ی قدیمی با شکست نوشتن (${failAll ? 'برگشت هم شکست می‌خورد' : 'فقط یک نوشتن شکست می‌خورد'}): هیچ‌کدام از دو داده گم نمی‌شود`, async () => {
    for (let failAt = 1; failAt <= 5; failAt += 1) {
      LS.testing.reset();
      const { base, ctl } = await armedStart();
      ctl.armed = true; ctl.failAt = failAt; ctl.failAll = failAll; ctl.n = 0;
      let ok = true;
      try { await LS.importLegacy(); } catch (e) { ok = false; }
      assert.ok(await recoverable(base.map, 'جدید-آزمون'), `نقطه‌ی شکست ${failAt}: داده‌ی فعلی باید بماند`);
      assert.ok(await recoverable(base.map, 'قدیمی-آزمون'), `نقطه‌ی شکست ${failAt}: نسخه‌ی قدیمی باید بماند`);
      if (!ok) assert.equal(LS.getStatus().locked, false, `نقطه‌ی شکست ${failAt}: قفل نباید بماند`);
    }
  });
}

for (const failAll of [false, true]) {
  test(`جابه‌جایی با شکست نوشتن (${failAll ? 'برگشت هم شکست می‌خورد' : 'فقط یک نوشتن شکست می‌خورد'}): داده‌ی فعلی و پشتیبان هیچ‌کدام گم نمی‌شوند`, async () => {
    for (let failAt = 1; failAt <= 7; failAt += 1) {
      LS.testing.reset();
      const { base, ctl } = await armedStart();
      await LS.importLegacy(); // اکنون: اصلی = قدیمی، پشتیبان = جدید
      ctl.armed = true; ctl.failAt = failAt; ctl.failAll = failAll; ctl.n = 0;
      let swapped = true;
      try { await LS.swapWithBackup(); } catch (e) { swapped = false; }
      assert.ok(await recoverable(base.map, 'جدید-آزمون'), `نقطه‌ی شکست ${failAt}: داده‌ی فعلی باید بماند`);
      assert.ok(await recoverable(base.map, 'قدیمی-آزمون'), `نقطه‌ی شکست ${failAt}: پشتیبان باید بماند`);
      // اگر جابه‌جایی شکست خورد و برگشت کامل شد، انبار موقت باید پاک شده باشد
      if (!swapped && !failAll) assert.equal(base.map.has(LS.SWAP_KEY), false, `نقطه‌ی شکست ${failAt}: انبار موقت باید پاک شود`);
    }
  });
}

// ---------- بازگردانی از فایل ----------
const restoredObj = (name) => ({
  orders: [], customers: [{ name, phone: '', note: '' }], staff: [], transactions: [],
  settings: { shopName: 'بازگردانی', ownerName: '', phone: '', address: '', currency: 'تومان' },
});

test('بازگردانی: داده‌ی فعلی به پشتیبان می‌رود و داده‌ی فایل جایگزین می‌شود؛ بعد از بارگذاری مجدد هم درست است', async () => {
  const { base, target } = await armedStart();
  // armedStart یک نسخه‌ی ساده‌ی قدیمی دارد؛ برای این آزمون آن را حذف می‌کنیم تا فقط بازگردانی بررسی شود
  base.map.delete(V2_KEY);
  const counts = await LS.restoreBackup(restoredObj('از-فایل'));
  assert.equal(counts.customers, 1);
  assert.equal(target.customers[0].name, 'از-فایل');
  assert.ok(base.map.get(BACKUP_KEY), 'داده‌ی فعلی در پشتیبان است');
  LS.testing.reset();
  const again = await startWith(base);
  assert.equal(again.target.customers[0].name, 'از-فایل');
});

test('بازگردانی دوم وقتی پشتیبان هست: رد می‌شود و هیچ‌چیز تغییر نمی‌کند', async () => {
  const { base, target } = await armedStart();
  base.map.delete(V2_KEY);
  await LS.restoreBackup(restoredObj('اول'));
  const snap = base.map.get(V3_KEY);
  const snapBak = base.map.get(BACKUP_KEY);
  await assert.rejects(() => LS.restoreBackup(restoredObj('دوم')), /پشتیبان محافظت‌شده/);
  assert.equal(base.map.get(V3_KEY), snap);
  assert.equal(base.map.get(BACKUP_KEY), snapBak);
  assert.equal(target.customers[0].name, 'اول');
});

test('بازگردانی در حالت فقط‌نشست یا قفل: رد می‌شود', async () => {
  const storage = fakeStorage();
  // بدون IndexedDB حالت persistent نیست
  LS.testing.setVaultMode('none');
  const r = await startWith(storage);
  assert.equal(r.st.persistent, false);
  await assert.rejects(() => LS.restoreBackup(restoredObj('x')), /ذخیره‌ی دائمی/);
});

for (const failAll of [false, true]) {
  test(`بازگردانی با شکست نوشتن (${failAll ? 'برگشت هم شکست می‌خورد' : 'یک نوشتن شکست می‌خورد'}): هیچ‌کدام از دو داده گم نمی‌شود`, async () => {
    for (let failAt = 1; failAt <= 5; failAt += 1) {
      LS.testing.reset();
      const { base, ctl } = await armedStart();
      base.map.delete(V2_KEY);
      ctl.armed = true; ctl.failAt = failAt; ctl.failAll = failAll; ctl.n = 0;
      try { await LS.restoreBackup(restoredObj('از-فایل')); } catch (e) { /* مجاز */ }
      assert.ok(await recoverable(base.map, 'جدید-آزمون'), `نقطه‌ی شکست ${failAt}: داده‌ی فعلی باید بماند`);
      // یا بازگردانی کامل شده، یا داده‌ی فعلی همچنان در انبار اصلی است
      const restored = await recoverable(base.map, 'از-فایل');
      const kept = await recoverable(base.map, 'جدید-آزمون');
      assert.ok(restored || kept, `نقطه‌ی شکست ${failAt}`);
    }
  });
}
