// آزمون‌های واحد درخواست ماندگاری داده (navigator.storage.persist) در js/local-store.js.
// navigator با یک شیء ساختگی جایگزین می‌شود؛ هیچ داده‌ی واقعی یا شبکه‌ای در کار نیست.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
require("../js/local-store.js");

const LS = globalThis.LocalStore;

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

beforeEach(() => {
  LS.testing.reset();
  setNavigator(undefined); // Node 20 navigator ندارد؛ هر آزمون وضعیت خودش را می‌سازد
});

test("مرورگر بدون StorageManager: پشتیبانی نشده، بدون خطا", async () => {
  setNavigator({});
  const r = await LS.requestPersistence();
  assert.deepEqual(r, { checked: true, supported: false, persisted: false });
  assert.deepEqual(LS.getPersistence(), r);
});

test("persist موفق: ماندگاری فعال", async () => {
  let calls = 0;
  setNavigator({
    storage: {
      persisted: async () => false,
      persist: async () => { calls += 1; return true; },
    },
  });
  const r = await LS.requestPersistence();
  assert.equal(calls, 1, "persist یک‌بار فراخوانی شد");
  assert.deepEqual(r, { checked: true, supported: true, persisted: true });
});

test("اگر از قبل ماندگار است، persist دوباره فراخوانی نمی‌شود", async () => {
  let calls = 0;
  setNavigator({
    storage: {
      persisted: async () => true,
      persist: async () => { calls += 1; return false; },
    },
  });
  const r = await LS.requestPersistence();
  assert.equal(calls, 0);
  assert.equal(r.persisted, true);
});

test("مرورگر اجازه نداد: persisted=false و بدون خطا", async () => {
  setNavigator({
    storage: { persisted: async () => false, persist: async () => false },
  });
  const r = await LS.requestPersistence();
  assert.deepEqual(r, { checked: true, supported: true, persisted: false });
});

test("خطای API نباید برنامه را متوقف کند و به «اجازه داده نشد» تبدیل می‌شود", async () => {
  setNavigator({
    storage: {
      persisted: async () => { throw new Error("boom"); },
      persist: async () => true,
    },
  });
  const r = await LS.requestPersistence();
  assert.deepEqual(r, { checked: true, supported: true, persisted: false });
});

test("مقدار غیر boolean از persist به‌عنوان اجازه نشده حساب می‌شود", async () => {
  setNavigator({
    storage: { persist: async () => "yes" },
  });
  const r = await LS.requestPersistence();
  assert.equal(r.persisted, false, "فقط true دقیق اجازه‌ی ماندگاری است");
});

test("درخواست ماندگاری داده یا کلید را تغییر نمی‌دهد", async () => {
  const storage = new Map();
  setNavigator({ storage: { persist: async () => true, persisted: async () => false } });
  const target = {};
  const st = await LS.init({
    storage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    target,
    seed: () => ({ orders: [], customers: [], staff: [], transactions: [], settings: { shopName: "x", ownerName: "", phone: "", address: "", currency: "تومان" } }),
  });
  const before = new Map(storage);
  await LS.requestPersistence();
  assert.equal(st.ready, true);
  assert.deepEqual(new Map(storage), before, "انبار بدون تغییر ماند");
});
