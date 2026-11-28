// آزمون‌های واحد یادآور پشتیبان (js/local-store.js). زمان با پارامتر now تزریق می‌شود؛ ساعت واقعی لازم نیست.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
require("../js/local-store.js");

const LS = globalThis.LocalStore;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);

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

async function start(storage) {
  return LS.init({ storage, target: {}, seed });
}

beforeEach(() => LS.testing.reset());

test("هرگز پشتیبان گرفته نشده: یادآور فعال است و زمان ندارد", async () => {
  await start(fakeStorage());
  const s = LS.backupReminderState(NOW);
  assert.equal(s.lastBackupAt, null);
  assert.equal(s.due, true);
  assert.equal(s.daysSince, null);
  assert.equal(s.thresholdDays, 7);
});

test("پشتیبان همین الان: امروز و بدون هشدار", async () => {
  const storage = fakeStorage();
  await start(storage);
  assert.equal(LS.markBackupDone(NOW), true);
  const s = LS.backupReminderState(NOW);
  assert.equal(s.daysSince, 0);
  assert.equal(s.due, false);
});

test("۶ روز بعد هنوز هشدار نیست، ۷ روز بعد هشدار است", async () => {
  await start(fakeStorage());
  LS.markBackupDone(NOW);
  assert.equal(LS.backupReminderState(NOW + 6 * DAY).due, false);
  assert.equal(LS.backupReminderState(NOW + 6 * DAY).daysSince, 6);
  assert.equal(LS.backupReminderState(NOW + 7 * DAY).due, true);
  assert.equal(LS.backupReminderState(NOW + 7 * DAY).daysSince, 7);
});

test("زمان آخرین پشتیبان در آینده (بیش از یک روز) نامعتبر است و هشدار می‌دهد", async () => {
  const storage = fakeStorage({ [LS.META_KEY]: JSON.stringify({ lastBackupAt: NOW + 5 * DAY }) });
  await start(storage);
  const s = LS.backupReminderState(NOW);
  assert.equal(s.lastBackupAt, null);
  assert.equal(s.due, true);
});

test("کمی جلوتر از ساعت دستگاه (کمتر از یک روز) پذیرفته می‌شود و منفی نمی‌شود", async () => {
  const storage = fakeStorage({ [LS.META_KEY]: JSON.stringify({ lastBackupAt: NOW + 60 * 1000 }) });
  await start(storage);
  const s = LS.backupReminderState(NOW);
  assert.equal(s.daysSince, 0);
  assert.equal(s.due, false);
});

test("کلید خراب یا غیرعدد: مثل «هرگز» رفتار می‌شود و خطا نمی‌دهد", async () => {
  for (const raw of ["{not json", JSON.stringify({ lastBackupAt: "yesterday" }), JSON.stringify([1, 2]), "null"]) {
    LS.testing.reset();
    await start(fakeStorage({ [LS.META_KEY]: raw }));
    const s = LS.backupReminderState(NOW);
    assert.equal(s.due, true, "برای " + raw);
    assert.equal(s.lastBackupAt, null);
  }
});

test("کلید یادآور فقط زمان را دارد و هیچ داده‌ی مشتری در آن نیست", async () => {
  const storage = fakeStorage();
  await start(storage);
  LS.markBackupDone(NOW);
  const raw = storage.map.get(LS.META_KEY);
  assert.deepEqual(JSON.parse(raw), { lastBackupAt: NOW });
  assert.equal(raw.includes("نمونه"), false);
});

test("ثبت پشتیبان داده‌ی رمزشده‌ی حالت محلی را تغییر نمی‌دهد", async () => {
  const storage = fakeStorage();
  await start(storage);
  const before = new Map(storage.map);
  LS.markBackupDone(NOW);
  for (const [k, v] of before) assert.equal(storage.map.get(k), v, "کلید " + k + " بدون تغییر است");
  assert.equal(storage.map.has(LS.V3_KEY), false);
});

test("خطای نوشتن کلید یادآور برنامه را متوقف نمی‌کند", async () => {
  const storage = fakeStorage();
  await start(storage);
  storage.setItem = () => { throw new Error("quota"); };
  assert.equal(LS.markBackupDone(NOW), false);
  assert.equal(LS.backupReminderState(NOW).due, true);
});
