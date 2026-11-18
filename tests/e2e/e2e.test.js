// تست‌های مرورگری حالت سرور.
// نیاز به سرور در حال اجرا با داده‌ی تستی:
//   E2E_BASE=http://127.0.0.1:3000  E2E_EMAIL=...  E2E_PASSWORD=...
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE || "http://127.0.0.1:3000";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

let browser;
let page;
let customerName = "";
const pageErrors = [];

before(async () => {
  if (!EMAIL || !PASSWORD) throw new Error("E2E_EMAIL و E2E_PASSWORD لازم است");
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // حالت سرور را فعال می‌کنیم؛ پیش‌فرض برنامه همچنان محلی است
  await ctx.addInitScript(() => {
    window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" };
  });
  page = await ctx.newPage();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.goto(BASE + "/index.html");
});

after(async () => {
  await browser?.close();
});

test("صفحه ورود نمایش داده می‌شود و ورود نادرست پیام می‌دهد", async () => {
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', EMAIL);
  await page.fill('#loginForm input[name="password"]', "wrong-password-123");
  await page.click('#loginForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#loginError").textContent.length > 0);
  const msg = await page.textContent("#loginError");
  assert.ok(msg.length > 0);
  assert.equal(await page.isVisible("#loginGate"), true);
});

test("ورود درست، مشتری و سفارش ثبت می‌شود و وضعیت تغییر می‌کند", async () => {
  await page.fill('#loginForm input[name="email"]', EMAIL);
  await page.fill('#loginForm input[name="password"]', PASSWORD);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });

  customerName = "مشتری تستی " + Date.now();
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', customerName);
  await page.fill('#customerForm input[name="phone"]', "09121234567");
  await page.click('#customerForm button[type="submit"]');
  await page.waitForFunction((n) => document.querySelector("#customersBody").textContent.includes(n), customerName);

  await page.click('.nav-item[data-page="orders"]');
  await page.click("#addOrderBtn");
  await page.fill('#orderForm input[name="customer"]', customerName);
  await page.fill('#orderForm input[name="description"]', "کت و شلوار تستی");
  await page.fill('#orderForm input[name="price"]', "1500000");
  await page.click('#orderForm button[type="submit"]');
  await page.waitForFunction((n) => document.querySelector("#ordersBody").textContent.includes(n), customerName);

  const row = page.locator("#ordersBody tr", { hasText: customerName }).first();
  await row.locator("[data-status-index]").click();
  await page.waitForFunction(() => document.querySelector("#ordersBody").textContent.includes("در حال دوخت"));
});

test("داده‌ها بعد از بارگذاری مجدد صفحه از سرور برمی‌گردند", async () => {
  await page.reload();
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await page.click('.nav-item[data-page="orders"]');
  await page.waitForFunction((n) => document.querySelector("#ordersBody").textContent.includes(n), customerName);
});

test("خروج از حساب، صفحه ورود را برمی‌گرداند", async () => {
  await page.click('.nav-item[data-page="settings"]');
  await page.click("#logoutBtn");
  await page.waitForSelector("#loginGate:not([hidden])");
});

test("هیچ خطای جاوااسکریپتی رخ نداده است", () => {
  assert.deepEqual(pageErrors, []);
});
