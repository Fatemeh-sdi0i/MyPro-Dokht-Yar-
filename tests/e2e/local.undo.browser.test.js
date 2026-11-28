// تست مرورگری حذف و بازگردانی نرم در حالت محلی: مشتری، سفارش و همکار (Chromium).
// فقط داده‌ی نمونه‌ی برنامه استفاده می‌شود؛ کانتکست موقت است و هیچ سرور یا شبکه‌ای لازم نیست.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

const CUSTOMER = "مریم احمدی";      // دو سفارش فعال در داده‌ی نمونه (یکی در حال دوخت)
const CUSTOMER_TWO = "نگار رضایی";  // برای آزمون ثبت سفارش جدید پس از حذف
const ORDER = "۱۴۰۵-۰۲۱";
const ORDER_DELIVERED = "۱۴۰۵-۰۱۹";
const STAFF = "زهرا نوری";

let server, base, browser;
const pageErrors = [];
const contexts = [];

before(async () => {
  server = http.createServer((req, res) => {
    const clean = req.url.split("?")[0];
    const p = path.join(ROOT, clean === "/" ? "index.html" : clean);
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  server?.close();
});

// هر سناریو کانتکست جدا دارد؛ همه‌ی confirm ها پذیرفته می‌شوند
async function openApp() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/index.html");
  await page.waitForSelector("body[data-ready]", { timeout: 10000 });
  return page;
}

async function reload(page) {
  await page.goto(base + "/index.html");
  await page.waitForSelector("body[data-ready]", { timeout: 10000 });
}

const nav = (page, name) => page.click(`.nav-item[data-page="${name}"]`);
const rowOf = (page, body, text) => page.locator(`${body} tr`, { hasText: text });
const openDetails = (page, sel) => page.evaluate((s) => { document.querySelector(s).open = true; }, sel);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s).textContent, sel);

async function waitGone(page, body, name) {
  await page.waitForFunction(([b, n]) => ![...document.querySelectorAll(`${b} tr`)].some((tr) => tr.textContent.includes(n)), [body, name], { timeout: 5000 });
}
async function waitHas(page, body, name) {
  await page.waitForFunction(([b, n]) => [...document.querySelectorAll(`${b} tr`)].some((tr) => tr.textContent.includes(n)), [body, name], { timeout: 5000 });
}

test("حذف مشتری: از فهرست می‌رود، سفارش‌هایش می‌مانند و برچسب «مشتری حذف شده» می‌گیرند", async () => {
  const page = await openApp();
  await nav(page, "customers");
  await rowOf(page, "#customersBody", CUSTOMER).locator("[data-delete-customer]").click();
  await waitGone(page, "#customersBody", CUSTOMER);
  await waitHas(page, "#custDeletedBody", CUSTOMER);
  assert.equal(await text(page, "#customerCount"), "۴");
  assert.equal(await page.evaluate(() => document.querySelector("#custDeletedWrap").hidden), false);

  await nav(page, "orders");
  const row = rowOf(page, "#ordersBody", ORDER);
  await row.waitFor({ timeout: 5000 });
  assert.match(await row.textContent(), /مشتری حذف شده/);
  assert.equal(await row.locator("[data-status-index]").count(), 0, "تغییر وضعیت برای سفارش قفل‌شده نیست");
  assert.equal(await row.locator("[data-delete-order]").count(), 0, "حذف سفارش قفل‌شده ممکن نیست");
});

test("حذف مشتری در بازآغاز صفحه ماندگار است", async () => {
  const page = await openApp();
  await nav(page, "customers");
  await rowOf(page, "#customersBody", CUSTOMER).locator("[data-delete-customer]").click();
  await waitGone(page, "#customersBody", CUSTOMER);
  await reload(page);
  await nav(page, "customers");
  await waitHas(page, "#custDeletedBody", CUSTOMER);
  assert.equal(await rowOf(page, "#customersBody", CUSTOMER).count(), 0);
});

test("بازگردانی مشتری سفارش‌ها را خودکار برنمی‌گرداند؛ قفل سفارش‌ها برمی‌دارد", async () => {
  const page = await openApp();
  await nav(page, "customers");
  await rowOf(page, "#customersBody", CUSTOMER).locator("[data-delete-customer]").click();
  await waitGone(page, "#customersBody", CUSTOMER);
  await openDetails(page, "#custDeletedWrap");
  await rowOf(page, "#custDeletedBody", CUSTOMER).locator("[data-restore-customer]").click();
  await waitHas(page, "#customersBody", CUSTOMER);
  assert.equal(await text(page, "#customerCount"), "۵");

  await nav(page, "orders");
  const row = rowOf(page, "#ordersBody", ORDER);
  await row.waitFor({ timeout: 5000 });
  assert.equal(await row.locator("[data-status-index]").count(), 1, "سفارش پس از بازگردانی مشتری قابل تغییر است");
  assert.doesNotMatch(await row.textContent(), /مشتری حذف شده/);
});

test("حذف و بازگردانی سفارش: از فهرست می‌رود و درآمد تحویل‌شده هم به‌روز می‌شود", async () => {
  const page = await openApp();
  await nav(page, "dashboard");
  const before = await text(page, "#revenueTotal");
  await nav(page, "orders");
  await rowOf(page, "#ordersBody", ORDER_DELIVERED).locator("[data-delete-order]").click();
  await page.waitForFunction((id) => ![...document.querySelectorAll("#ordersBody tr")].some((tr) => tr.textContent.includes(id)), ORDER_DELIVERED, { timeout: 5000 });
  await waitHas(page, "#orderDeletedBody", ORDER_DELIVERED);

  await nav(page, "dashboard");
  assert.notEqual(await text(page, "#revenueTotal"), before, "درآمد سفارش حذف‌شده کم شده است");

  await nav(page, "orders");
  await openDetails(page, "#orderDeletedWrap");
  await rowOf(page, "#orderDeletedBody", ORDER_DELIVERED).locator("[data-restore-order]").click();
  await waitHas(page, "#ordersBody", ORDER_DELIVERED);
  await nav(page, "dashboard");
  assert.equal(await text(page, "#revenueTotal"), before, "پس از بازگردانی درآمد برمی‌گردد");
});

test("همکار: حذف و بازگردانی، شمارنده‌ها را درست نگه می‌دارد", async () => {
  const page = await openApp();
  await nav(page, "coworkers");
  const total = await text(page, "#staffCount");
  await rowOf(page, "#staffBody", STAFF).locator("[data-delete-staff]").click();
  await waitGone(page, "#staffBody", STAFF);
  await waitHas(page, "#staffDeletedBody", STAFF);
  assert.notEqual(await text(page, "#staffCount"), total);

  await openDetails(page, "#staffDeletedWrap");
  await rowOf(page, "#staffDeletedBody", STAFF).locator("[data-restore-staff]").click();
  await waitHas(page, "#staffBody", STAFF);
  assert.equal(await text(page, "#staffCount"), total);
});

test("ثبت سفارش جدید برای مشتری حذف‌شده پذیرفته نمی‌شود", async () => {
  const page = await openApp();
  await nav(page, "customers");
  await rowOf(page, "#customersBody", CUSTOMER_TWO).locator("[data-delete-customer]").click();
  await waitGone(page, "#customersBody", CUSTOMER_TWO);

  await nav(page, "orders");
  const rowsBefore = await page.locator("#ordersBody tr").count();
  await page.click("#addOrderBtn");
  await page.fill('#orderForm input[name="customer"]', CUSTOMER_TWO);
  await page.fill('#orderForm input[name="description"]', "آزمون");
  await page.fill('#orderForm input[name="price"]', "100000");
  await page.click('#orderForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("این مشتری حذف شده است"), null, { timeout: 5000 });
  assert.equal(await page.locator("#ordersBody tr").count(), rowsBefore, "هیچ سفارش جدیدی ثبت نشده است");
});

test("نام مشتری حذف‌شده دوباره ثبت نمی‌شود و سفارش‌های قفل‌شده باز نمی‌شوند", async () => {
  const page = await openApp();
  await nav(page, "customers");
  await rowOf(page, "#customersBody", CUSTOMER).locator("[data-delete-customer]").click();
  await waitGone(page, "#customersBody", CUSTOMER);

  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', CUSTOMER);
  await page.fill('#customerForm input[name="phone"]', "09121234567");
  await page.click('#customerForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("حذف‌شده"), null, { timeout: 5000 });
  assert.equal(await text(page, "#customerCount"), "۴", "مشتری تکراری اضافه نشد");
  await waitHas(page, "#custDeletedBody", CUSTOMER);
  await page.click('#customerForm [data-close]');

  await nav(page, "orders");
  const row = rowOf(page, "#ordersBody", ORDER);
  await row.waitFor({ timeout: 5000 });
  assert.match(await row.textContent(), /مشتری حذف شده/, "سفارش هنوز قفل است");

  // نام تازه و یکتا همچنان ثبت می‌شود
  await nav(page, "customers");
  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', "نام-تازه-آزمایشی");
  await page.fill('#customerForm input[name="phone"]', "09129876543");
  await page.click('#customerForm button[type="submit"]');
  await waitHas(page, "#customersBody", "نام-تازه-آزمایشی");
  assert.equal(await text(page, "#customerCount"), "۵");
});

test("پشتیبان JSON رکوردهای حذف‌شده را با زمان حذف نگه می‌دارد", async () => {
  const page = await openApp();
  await nav(page, "customers");
  await rowOf(page, "#customersBody", CUSTOMER).locator("[data-delete-customer]").click();
  await waitGone(page, "#customersBody", CUSTOMER);
  await nav(page, "settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const file = await dl.path();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = data.customers.find((x) => x.name === CUSTOMER);
  assert.ok(c && typeof c.deletedAt === "string", "مشتری حذف‌شده با deletedAt در پشتیبان است");
});

test("هیچ خطای صفحه‌ای در همه‌ی سناریوها ثبت نشده است", () => {
  assert.deepEqual(pageErrors, []);
});
