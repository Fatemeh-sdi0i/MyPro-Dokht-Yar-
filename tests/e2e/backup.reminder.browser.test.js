// تست مرورگری یادآور پشتیبان حالت محلی (Chromium). داده‌ی آزمایشی ساختگی است و کانتکست‌ها جدا و موقت‌اند.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const META = "dokhtyar.meta.v1";
const DAY = 24 * 60 * 60 * 1000;
const NEVER = "هنوز هیچ پشتیبانی از داده‌های این مرورگر گرفته نشده است. همین حالا یک پشتیبان JSON دانلود کنید.";

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

async function openSettings(page) {
  await page.goto(base + "/index.html");
  await page.waitForSelector("body[data-ready]", { timeout: 10000 });
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForSelector("#backupReminder", { state: "attached" });
}

const reminderText = (page) => page.evaluate(() => document.querySelector("#backupReminder").textContent);

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  return page;
}

test("داده‌ی تازه: هنوز پشتیبانی گرفته نشده و یادآور نمایش داده می‌شود", async () => {
  const page = await newPage();
  await openSettings(page);
  assert.equal(await reminderText(page), NEVER);
});

test("دانلود JSON: زمان آخرین پشتیبان ثبت و «امروز» نشان داده می‌شود", async () => {
  const page = await newPage();
  await openSettings(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  assert.match(dl.suggestedFilename(), /dokhtyar-backup\.json$/);
  await page.waitForFunction(() => document.querySelector("#backupReminder").textContent.startsWith("آخرین پشتیبان: امروز"), null, { timeout: 5000 });
  assert.match(await reminderText(page), /^آخرین پشتیبان: امروز \(.+\)\.$/, "متن امروز با تاریخ شمسی");
});

test("پشتیبان ۸ روز پیش: هشدار «بیش از ۷ روز» نمایش داده می‌شود", async () => {
  const page = await newPage();
  await openSettings(page);
  await page.evaluate(([k, at]) => localStorage.setItem(k, JSON.stringify({ lastBackupAt: at })), [META, Date.now() - 8 * DAY]);
  await page.reload();
  await page.waitForSelector("body[data-ready]", { timeout: 10000 });
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForFunction(() => document.querySelector("#backupReminder").textContent.includes("بیش از ۷ روز"), null, { timeout: 5000 });
  const text = await reminderText(page);
  assert.match(text, /\(۸ روز پیش\)/);
  assert.match(text, /یک پشتیبان تازه بگیرید/);
});

test("پشتیبان رمزشده هم زمان را ثبت می‌کند و هشدار را برمی‌دارد", async () => {
  const page = await newPage();
  await openSettings(page);
  await page.evaluate(([k, at]) => localStorage.setItem(k, JSON.stringify({ lastBackupAt: at })), [META, Date.now() - 9 * DAY]);
  await page.reload();
  await page.waitForSelector("body[data-ready]", { timeout: 10000 });
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForFunction(() => document.querySelector("#backupReminder").textContent.includes("بیش از ۷ روز"), null, { timeout: 5000 });
  await page.fill("#backupPassword", "گذرواژه-آزمایشی-۱۲۳");
  await page.fill("#backupPassword2", "گذرواژه-آزمایشی-۱۲۳");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportEncryptedBtn")]);
  assert.match(dl.suggestedFilename(), /dokhtyar-backup-encrypted\.json$/);
  await page.waitForFunction(() => document.querySelector("#backupReminder").textContent.startsWith("آخرین پشتیبان: امروز"), null, { timeout: 8000 });
  assert.equal((await reminderText(page)).includes("بیش از"), false, "هشدار پس از پشتیبان رمزشده برداشته شد");
});

test("کلید یادآور فقط زمان دارد و هیچ داده‌ی مشتری یا گذرواژه در آن نیست", async () => {
  const page = await newPage();
  await openSettings(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  await dl.path();
  await page.waitForFunction((k) => !!localStorage.getItem(k), META, { timeout: 5000 });
  const raw = await page.evaluate((k) => localStorage.getItem(k), META);
  assert.deepEqual(Object.keys(JSON.parse(raw)), ["lastBackupAt"]);
  assert.equal(raw.includes("نمونه"), false);
});

test("هیچ خطای صفحه‌ای در همه‌ی سناریوها ثبت نشده است", () => {
  assert.deepEqual(pageErrors, []);
});
