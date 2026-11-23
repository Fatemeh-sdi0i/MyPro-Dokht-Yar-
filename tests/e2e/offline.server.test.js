// تست آفلاین روی سرور واقعی (Fastify + PostgreSQL) که CI بالا می‌آورد.
// بررسی می‌کند: ثبت آفلاین مشتری و سفارش، خروج آفلاین، تکمیل خروج با اتصال،
// ثبت دقیقاً یک‌بار روی PostgreSQL، باطل شدن نشست، و ایمنی تکرار با همان شناسه.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE || "http://127.0.0.1:3000";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const stamp = Date.now();
const CUSTOMER = `مشتری آفلاین سرور ${stamp}`;
const ORDER_DESC = `سفارش آفلاین ${stamp}`;

let browser, ctx, page;
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error("زمان انتظار تمام شد: " + label);
}
const pendingCount = () => page.evaluate(() => Sync.pendingCount());
const queueRaw = () => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open("dokhtyar-sync");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const req = db.transaction("queue", "readonly").objectStore("queue").count();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  };
}));
// فراخوانی API از همان مبدأ (کوکی نشست همین مرورگر)
const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch("/api/v1" + path, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

async function login() {
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', EMAIL);
  await page.fill('#loginForm input[name="password"]', PASSWORD);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await sleep(500);
}

before(async () => {
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" }; });
  page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE + "/index.html");
  await login();
});

after(async () => {
  await browser?.close();
});

test("ثبت آفلاین مشتری و سفارش، خروج آفلاین، و تکمیل روی PostgreSQL", async (t) => {
  await t.test("ثبت آفلاین مشتری و سفارش", async () => {
    await ctx.setOffline(true);
    await page.click('.nav-item[data-page="customers"]');
    await page.click("#addCustomerBtn");
    await page.fill('#customerForm input[name="name"]', CUSTOMER);
    await page.fill('#customerForm input[name="phone"]', "09121234567");
    await page.click('#customerForm button[type="submit"]');
    await sleep(300);
    await page.click('.nav-item[data-page="orders"]');
    await page.click("#addOrderBtn");
    await page.fill('#orderForm input[name="customer"]', CUSTOMER);
    await page.fill('#orderForm input[name="description"]', ORDER_DESC);
    await page.fill('#orderForm input[name="price"]', "750000");
    await page.click('#orderForm button[type="submit"]');
    await sleep(300);
    assert.equal(await pendingCount(), 2, "مشتری و سفارش باید در صف باشند");
  });

  await t.test("خروج آفلاین: صف (تغییرات + خروج) حفظ می‌شود و کش پاک می‌شود", async () => {
    await page.click('.nav-item[data-page="settings"]');
    await page.click("#logoutBtn");
    await page.waitForSelector("#loginGate:not([hidden])");
    assert.equal(await queueRaw(), 3, "مشتری + سفارش + خروج");
  });

  await t.test("اتصال: تکمیل صف و باطل شدن نشست روی سرور واقعی", async () => {
    await ctx.setOffline(false);
    // نشست هنوز روی سرور معتبر است؛ بوت باید ابتدا خروج‌ها را با همان نشست کامل کند
    await page.reload();
    await waitFor(async () => (await queueRaw()) === 0, "تخلیه‌ی صف و ثبت خروج");
    const me = await api("GET", "/auth/me");
    assert.equal(me.status, 401, "نشست سرور باید باطل شده باشد");
  });

  await t.test("ورود دوباره: هر تغییر دقیقاً یک‌بار روی PostgreSQL است", async () => {
    await login();
    const rejected = await page.evaluate(() => Sync.rejectedOps());
    const customers = await api("GET", "/customers?q=" + encodeURIComponent(CUSTOMER));
    const matched = customers.body.items.filter((c) => c.name === CUSTOMER);
    assert.equal(matched.length, 1,
      "مشتری یک‌بار ثبت شده | ردشده‌ها=" + JSON.stringify(rejected.map((r) => [r.method, r.path, r.reason])) +
      " | نتیجه‌ی جست‌وجو=" + JSON.stringify(customers.body.items.map((c) => c.name)).slice(0, 400));
    const orders = await api("GET", "/orders?q=" + encodeURIComponent(ORDER_DESC));
    const ords = orders.body.items.filter((o) => o.description === ORDER_DESC);
    assert.equal(ords.length, 1, "سفارش یک‌بار ثبت شده");
    assert.equal(ords[0].customer_id, matched[0].id, "سفارش به مشتری درست وصل است");
  });

  await t.test("تکرار ارسال با همان شناسه روی سرور: ۲۰۰ و بدون رکورد تازه", async () => {
    const id = crypto.randomUUID();
    const first = await api("POST", "/customers", { id, name: "تکرار " + stamp });
    const again = await api("POST", "/customers", { id, name: "تکرار " + stamp });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, id);
  });

  await t.test("صفحه بدون خطای برنامه کار کرده است", async () => {
    assert.deepEqual(pageErrors, []);
  });
});
