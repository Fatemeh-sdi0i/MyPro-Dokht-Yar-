// آزمون مرورگری انتقال داده‌ی مرورگر به سرور روی PostgreSQL واقعی.
// باید پیش از سایر آزمون‌های e2e اجرا شود، چون سرور باید خالی باشد.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE || "http://127.0.0.1:3000";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

let browser;
let page;
const dialogs = [];
const pageErrors = [];

before(async () => {
  if (!EMAIL || !PASSWORD) throw new Error("E2E_EMAIL و E2E_PASSWORD لازم است");
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" };
  });
  page = await ctx.newPage();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  // تأیید confirm و alert؛ متن‌ها ذخیره می‌شوند
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.accept();
  });
  await page.goto(BASE + "/index.html");
  // داده‌ی محلی نمونه، پیش از ورود
  await page.evaluate(() => {
    localStorage.setItem("dokhtyar.v2", JSON.stringify({
      orders: [
        { id: "۱۴۰۵-۰۰۷", customer: "پریا کاوه", type: "sewing", desc: "دوخت کت", created: "۱۴۰۵/۰۸/۰۵", due: "۱۴۰۵/۰۸/۲۰", status: "progress", price: 7400000 },
      ],
      customers: [
        { name: "پریا کاوه", phone: "۰۹۱۲۱۱۱۲۲۳۳", count: 1, last: "—", state: "VIP", note: "ترجیح رنگ مشکی" },
      ],
      staff: [{ id: 1, name: "سارا", role: "خیاط", phone: "", active: false }],
      transactions: [{ id: 1, date: "۱۴۰۵/۰۸/۱۰", kind: "expense", category: "پارچه", amount: 500000, note: "پارچه" }],
      settings: { shopName: "مزون انتقال", ownerName: "مدیر", phone: "", address: "تهران", currency: "تومان" },
    }));
  });
  await page.reload();
});

after(async () => {
  await browser?.close();
});

test("انتقال داده‌ی مرورگر به سرور خالی، با حفظ شماره و تاریخ سفارش", async () => {
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', EMAIL);
  await page.fill('#loginForm input[name="password"]', PASSWORD);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });

  await page.click('.nav-item[data-page="settings"]');
  await page.waitForSelector("#importBtn:not([hidden])");
  await page.click("#importBtn");
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("منتقل شدند"), null, { timeout: 20000 });

  // دکمه بعد از انتقال پنهان می‌شود
  assert.equal(await page.isVisible("#importBtn"), false);

  const server = await page.evaluate(async () => ({
    orders: (await Api.orders()).items.map((o) => ({ no: o.order_no, created: o.created_on, customer: o.customer_name })),
    customers: (await Api.customers()).items.map((c) => ({ name: c.name, phone: c.phone, tier: c.tier })),
    transactions: (await Api.transactions()).items.length,
    staff: (await Api.staff()).items.map((s) => ({ name: s.name, active: s.active })),
  }));

  assert.deepEqual(server.orders, [{ no: 7, created: "2026-10-27", customer: "پریا کاوه" }]);
  assert.deepEqual(server.customers, [{ name: "پریا کاوه", phone: "09121112233", tier: "vip" }]);
  assert.equal(server.transactions, 1);
  assert.deepEqual(server.staff, [{ name: "سارا", active: false }]);
  assert.deepEqual(dialogs.length >= 1, true);
});

test("بار دوم انتقال انجام نمی‌شود", async () => {
  await page.reload();
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await page.click('.nav-item[data-page="settings"]');
  assert.equal(await page.isVisible("#importBtn"), false);
});

test("هیچ خطای جاوااسکریپتی رخ نداده است", () => {
  assert.deepEqual(pageErrors, []);
});
