// تست مرورگری حذف نرم و بازگردانی تراکنش در حالت محلی: جمع‌ها، فهرست حذف‌شده‌ها، ماندگاری پس از بارگذاری مجدد.
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

async function openApp(dialogs = []) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const plan = [...dialogs];
  const unexpected = [];
  page.on("dialog", (d) => {
    const step = plan.shift();
    if (!step) { unexpected.push(d.message()); return d.dismiss(); }
    return step.ok ? d.accept() : d.dismiss();
  });
  await page.goto(base + "/index.html");
  await waitFor(() => page.evaluate(() => document.body.dataset.ready === "true"), "آماده شدن");
  return { ctx, page, errors, unexpected };
}

async function addIncome(page, amount) {
  await page.click('.nav-item[data-page="finance"]');
  await page.click("#addTxBtn");
  await page.fill('#txForm input[name="amount"]', String(amount));
  await page.click('#txForm button[type="submit"]');
  await sleep(200);
}

const liveTotal = (page) => page.evaluate(() => state.transactions.filter((t) => !t.deletedAt).reduce((s, t) => s + t.amount, 0));
const deletedCount = (page) => page.evaluate(() => state.transactions.filter((t) => t.deletedAt).length);

test("حذف نرم: از جمع‌ها کم می‌شود، در فهرست حذف‌شده‌ها می‌ماند و با بازگردانی برمی‌گردد", async () => {
  const { page, errors, unexpected } = await openApp([{ ok: true }]);
  const base = await liveTotal(page); // داده‌ی نمونه دارد؛ همه‌ی مقایسه‌ها نسبت به مبنا است
  await addIncome(page, 125000);
  assert.equal(await liveTotal(page), base + 125000);

  const row = await page.evaluate(() => state.transactions.find((t) => t.amount === 125000).id);
  await page.click(`[data-delete-tx="${row}"]`);
  await waitFor(async () => (await deletedCount(page)) === 1, "حذف نرم");
  assert.equal(await liveTotal(page), base, "در جمع‌ها نیست");
  assert.equal(await page.evaluate(() => !document.querySelector("#txDeletedWrap").hidden), true, "بخش حذف‌شده‌ها دیده می‌شود");
  assert.equal(await page.evaluate(() => state.transactions.some((t) => t.amount === 125000)), true, "ردیف هنوز در داده است");

  // پس از بارگذاری مجدد هم حذف‌شده می‌ماند
  await page.reload();
  await waitFor(() => page.evaluate(() => document.body.dataset.ready === "true"), "بارگذاری مجدد");
  await waitFor(async () => (await deletedCount(page)) === 1, "ماندگاری حذف");
  assert.equal(await liveTotal(page), base);

  await page.click('.nav-item[data-page="finance"]');
  await page.click("#txDeletedWrap summary"); // بخش حذف‌شده‌ها بسته است؛ کاربر آن را باز می‌کند
  await page.click(`[data-restore-tx="${row}"]`);
  await waitFor(async () => (await liveTotal(page)) === base + 125000, "بازگردانی");
  assert.equal(await deletedCount(page), 0);
  assert.equal(await page.evaluate(() => document.querySelector("#txDeletedWrap").hidden), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
});

test("تراکنش حذف‌شده در گزارش و جمع امور مالی نیست؛ لغو تأیید حذف را انجام نمی‌دهد", async () => {
  const { page, errors } = await openApp([{ ok: false }]);
  const base = await liveTotal(page);
  await addIncome(page, 50000);
  const row = await page.evaluate(() => state.transactions.find((t) => t.amount === 50000).id);
  await page.click(`[data-delete-tx="${row}"]`); // تأیید رد می‌شود
  await sleep(200);
  assert.equal(await liveTotal(page), base + 50000, "بدون تأیید چیزی حذف نشد");
  assert.equal(await deletedCount(page), 0);
  assert.deepEqual(errors, []);
});
