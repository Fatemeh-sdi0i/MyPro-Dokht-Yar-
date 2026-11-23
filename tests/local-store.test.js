// آزمون‌های واحد ذخیره‌سازی رمزشده‌ی حالت محلی (js/local-store.js).
// localStorage با یک انبار ساختگی و کلید با حافظه‌ی داخلی (بدون IndexedDB) شبیه‌سازی می‌شود.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
require("../js/local-store.js");

const LS = globalThis.LocalStore;
const { V2_KEY, V3_KEY } = LS;

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
