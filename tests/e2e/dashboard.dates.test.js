// تست مرورگری حالت محلی: اعتبارسنجی تاریخ در فرم‌ها و نمودار عملکرد ماهانه.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
let server, base, browser;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error("زمان انتظار تمام شد: " + label);
}

async function openApp() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/index.html");
  await waitFor(() => page.evaluate(() => document.readyState === "complete"), "بارگذاری");
  return { page, errors };
}

const toastText = (page) => page.evaluate(() => document.querySelector("#toast").textContent);
const orderCount = (page) => page.evaluate(() => state.orders.length);
const txCount = (page) => page.evaluate(() => state.transactions.length);

async function addOrder(page, { due, price, status = "delivered", customer = "مشتری-تاریخ" }) {
  // پس از تاریخ نامعتبر، فرم باز می‌ماند (رفتار مورد انتظار)؛ پیش از تلاش بعدی با Escape می‌بندیم
  await page.keyboard.press("Escape");
  await page.click('.nav-item[data-page="orders"]');
  await page.click("#addOrderBtn");
  await page.fill('#orderForm input[name="customer"]', customer);
  await page.fill('#orderForm input[name="description"]', "دوخت-آزمون");
  await page.fill('#orderForm input[name="due"]', due);
  await page.fill('#orderForm input[name="price"]', String(price));
  await page.selectOption('#orderForm select[name="status"]', status);
  await page.click('#orderForm button[type="submit"]');
  await sleep(250);
}

test("فرم سفارش: تاریخ تحویل نامعتبر پذیرفته نمی‌شود؛ تاریخ معتبر ذخیره می‌شود", async () => {
  const { page, errors } = await openApp();
  const before = await orderCount(page);
  await addOrder(page, { due: "۱۴۰۵/۰۷/۳۱", price: 100000 }); // مهر ۳۱ روز ندارد
  assert.equal(await orderCount(page), before, "سفارش با روز ناموجود ثبت نشد");
  assert.match(await toastText(page), /تاریخ تحویل باید معتبر/);
  await addOrder(page, { due: "۱۴۰۵/۱۳/۰۱", price: 100000 }); // ماه ۱۳
  assert.equal(await orderCount(page), before, "ماه نامعتبر ثبت نشد و خطا هم نداد");
  await addOrder(page, { due: "۱۴۰۵/۰۸/۱۰", price: 100000, status: "waiting" });
  assert.equal(await orderCount(page), before + 1);
  assert.equal(await page.evaluate(() => state.orders[0].due), "۱۴۰۵/۰۸/۱۰");
  assert.deepEqual(errors, []);
});

test("فرم تراکنش: تاریخ نامعتبر رد می‌شود", async () => {
  const { page, errors } = await openApp();
  await page.click('.nav-item[data-page="finance"]');
  await page.click("#addTxBtn");
  await page.fill('#txForm input[name="amount"]', "50000");
  await page.fill('#txForm input[name="date"]', "۱۴۰۵/۱۳/۰۱");
  const before = await txCount(page);
  await page.click('#txForm button[type="submit"]');
  await sleep(250);
  assert.equal(await txCount(page), before);
  assert.match(await toastText(page), /تاریخ باید معتبر/);
  assert.deepEqual(errors, []);
});

test("نمودار عملکرد ماهانه از سفارش‌های تحویل‌شده ساخته می‌شود", async () => {
  const { page, errors } = await openApp();
  await addOrder(page, { due: "۱۴۰۵/۰۸/۱۰", price: 500000 }); // آبان، تحویل‌شده
  await page.click('.nav-item[data-page="dashboard"]').catch(() => {});
  await waitFor(() => page.evaluate(() => document.querySelectorAll("#monthlyChart circle").length === 12), "نقاط نمودار");
  const labels = await page.textContent("#monthlyLabels");
  assert.match(labels, /آبان/);
  assert.equal(await page.evaluate(() => document.querySelector("#monthlyNote").hidden), true, "بدون تاریخ‌های بدون مقدار، یادداشت نیست");
  // نقطه‌ی آبان بالاترین است (بیشینه‌ی نمودار)
  const cys = await page.evaluate(() => [...document.querySelectorAll("#monthlyChart circle")].map((c) => parseFloat(c.getAttribute("cy"))));
  assert.equal(Math.min(...cys), cys[7], "آبان (ماه هشتم) بالاترین نقطه است");
  // سفارش بدون تاریخ تحویل در مجموع هست و یادداشت توضیح می‌دهد
  await addOrder(page, { due: "", price: 200000, customer: "بدون-تاریخ" });
  await page.click('.nav-item[data-page="dashboard"]').catch(() => {});
  await waitFor(() => page.evaluate(() => !document.querySelector("#monthlyNote").hidden), "یادداشت نمودار");
  assert.match(await page.textContent("#monthlyNote"), /در نمودار نمی‌آیند/);
  assert.deepEqual(errors, []);
});

test("بازه‌ی شش ماه اخیر برچسب‌های کمتری دارد", async () => {
  const { page, errors } = await openApp();
  await page.selectOption("#monthlyRange", "half");
  assert.equal(await page.evaluate(() => document.querySelectorAll("#monthlyLabels span").length), 6);
  await page.selectOption("#monthlyRange", "year");
  assert.equal(await page.evaluate(() => document.querySelectorAll("#monthlyLabels span").length), 12);
  assert.deepEqual(errors, []);
});
