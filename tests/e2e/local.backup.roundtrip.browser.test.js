// رفت‌وبرگشت پشتیبان حالت محلی با رکوردهای حذف‌شده (Chromium).
// پشتیبان ساده گرفته می‌شود، داده تغییر داده می‌شود، و بازگردانی باید حالت حذف‌شده‌ها را دقیق برگرداند.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const CUSTOMER = "مریم احمدی";
const ORDER_DELIVERED = "۱۴۰۵-۰۱۹";
const STAFF = "زهرا نوری";
const LATER = "مشتری-بعد-از-پشتیبان";

let server, base, browser;
const pageErrors = [];
const contexts = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dokhtyar-roundtrip-"));

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
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function openApp() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // عبارت تأیید «بازگردانی» را می‌خواهد؛ بقیه‌ی تأییدها پذیرفته می‌شوند
  page.on("dialog", (d) => (d.type() === "prompt" ? d.accept("بازگردانی") : d.accept()));
  await page.goto(base + "/index.html");
  await page.waitForSelector("body[data-ready]", { timeout: 10000 });
  return page;
}

const nav = (page, name) => page.click(`.nav-item[data-page="${name}"]`);
const rowOf = (page, body, text) => page.locator(`${body} tr`, { hasText: text });
const bodyHas = (page, body, name) => page.evaluate(([b, n]) => [...document.querySelectorAll(`${b} tr`)].some((tr) => tr.textContent.includes(n)), [body, name]);
const expand = (page, sel) => page.evaluate((s) => { document.querySelector(s).open = true; }, sel);
const countText = (page, sel) => page.evaluate((s) => document.querySelector(s).textContent, sel);
const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function waitFor(fn, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("زمان انتظار تمام شد: " + label);
}

test("پشتیبان با رکوردهای حذف‌شده، بازگردانی را دقیقاً به همان حالت برمی‌گرداند", async () => {
  const page = await openApp();

  // ۱) حذف مشتری، سفارش و همکار؛ سپس پشتیبان ساده
  await nav(page, "customers");
  await rowOf(page, "#customersBody", CUSTOMER).locator("[data-delete-customer]").click();
  await waitFor(async () => !(await bodyHas(page, "#customersBody", CUSTOMER)), "حذف مشتری");
  await nav(page, "orders");
  await rowOf(page, "#ordersBody", ORDER_DELIVERED).locator("[data-delete-order]").click();
  await waitFor(async () => !(await bodyHas(page, "#ordersBody", ORDER_DELIVERED)), "حذف سفارش");
  await nav(page, "coworkers");
  await rowOf(page, "#staffBody", STAFF).locator("[data-delete-staff]").click();
  await waitFor(async () => !(await bodyHas(page, "#staffBody", STAFF)), "حذف همکار");

  await nav(page, "settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const file = path.join(tmp, "backup.json");
  await dl.saveAs(file);

  // ۲) تغییر داده پس از پشتیبان: یک مشتری تازه و بازگردانی همکار
  await nav(page, "customers");
  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', LATER);
  await page.fill('#customerForm input[name="phone"]', "09121112233");
  await page.click('#customerForm button[type="submit"]');
  await waitFor(async () => bodyHas(page, "#customersBody", LATER), "مشتری تازه");

  // ۳) بازگردانی از فایل
  await nav(page, "settings");
  await page.setInputFiles("#backupCheckFile", file);
  await page.click("#backupCheckBtn");
  await waitFor(async () => (await bodyText(page)).includes("فایل ساده معتبر است"), "بررسی فایل");
  await page.click("#backupRestoreBtn");
  await waitFor(async () => (await bodyText(page)).includes("بازگردانی شد"), "پیام موفقیت بازگردانی");

  // ۴) حالت باید دقیقاً همان لحظه‌ی پشتیبان باشد
  await nav(page, "customers");
  assert.equal(await bodyHas(page, "#customersBody", LATER), false, "مشتری بعد از پشتیبان حذف شده است");
  await expand(page, "#custDeletedWrap");
  assert.equal(await bodyHas(page, "#custDeletedBody", CUSTOMER), true, "مشتری حذف‌شده همچنان حذف‌شده است");
  await nav(page, "orders");
  await expand(page, "#orderDeletedWrap");
  assert.equal(await bodyHas(page, "#orderDeletedBody", ORDER_DELIVERED), true, "سفارش حذف‌شده همچنان حذف‌شده است");
  await nav(page, "coworkers");
  await expand(page, "#staffDeletedWrap");
  assert.equal(await bodyHas(page, "#staffDeletedBody", STAFF), true, "همکار حذف‌شده همچنان حذف‌شده است");
  assert.equal(await countText(page, "#staffCount"), "۲", "شمارنده‌ی همکاران درست است");
});

test("پشتیبان نسخه‌ی قدیمی بدون deletedAt همه‌ی رکوردها را فعال نشان می‌دهد", async () => {
  const page = await openApp();
  const legacy = {
    version: 3,
    customers: [{ name: "قدیمی-یک", phone: "", count: 0, last: "—", state: "فعال", note: "" }],
    orders: [],
    staff: [],
    transactions: [],
    settings: { shopName: "مزون", ownerName: "", phone: "", address: "", currency: "تومان" },
  };
  const file = path.join(tmp, "legacy.json");
  fs.writeFileSync(file, JSON.stringify(legacy));
  await nav(page, "settings");
  await page.setInputFiles("#backupCheckFile", file);
  await page.click("#backupCheckBtn");
  await waitFor(async () => (await bodyText(page)).includes("فایل ساده معتبر است"), "بررسی فایل قدیمی");
  await page.click("#backupRestoreBtn");
  await waitFor(async () => (await bodyText(page)).includes("بازگردانی شد"), "بازگردانی فایل قدیمی");
  await nav(page, "customers");
  assert.equal(await bodyHas(page, "#customersBody", "قدیمی-یک"), true, "رکورد قدیمی فعال است");
  assert.equal(await page.evaluate(() => document.querySelector("#custDeletedWrap").hidden), true, "بخش حذف‌شده‌ها خالی است");
});

test("هیچ خطای صفحه‌ای ثبت نشده است", () => {
  assert.deepEqual(pageErrors, []);
});
