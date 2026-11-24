// تست مرورگری پشتیبان: دانلود رمزشده، ساده‌ی قدیمی بدون تغییر، و بررسی فایل که هیچ داده‌ای را تغییر نمی‌دهد.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const V3 = "dokhtyar.v3";
const PASS = "گذرواژه-آزمون-۱۲۳";
const CUSTOMER = "مشتری-رمزی-۱";
const PHONE = "09121234567";

let server, base, browser;
const contexts = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dokhtyar-backup-"));

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
  const unexpectedDialogs = [];
  page.on("dialog", (d) => { unexpectedDialogs.push(d.message()); d.dismiss(); });
  await page.goto(base + "/index.html");
  await waitFor(() => page.evaluate(() => document.readyState === "complete"), "بارگذاری صفحه");
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill("#customerForm input[name=name]", CUSTOMER);
  await page.fill("#customerForm input[name=phone]", PHONE);
  await page.click("#customerForm button[type=submit]");
  await waitFor(() => page.evaluate((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), CUSTOMER), "نمایش مشتری");
  await page.click('.nav-item[data-page="settings"]');
  return { page, errors, unexpectedDialogs };
}

const raw = (page) => page.evaluate((k) => localStorage.getItem(k), V3);
const msg = (page) => page.evaluate(() => ({ text: document.querySelector("#backupMsg").textContent, state: document.querySelector("#backupMsg").dataset.state }));

async function download(page, clickSelector) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(clickSelector)]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  return { file, name: dl.suggestedFilename(), text: fs.readFileSync(file, "utf8") };
}

test("دانلود رمزشده: گذرواژه‌ی ناهمخوان و کوتاه رد می‌شوند و فایلی دانلود نمی‌شود", async () => {
  const { page, errors, unexpectedDialogs } = await openApp();
  const snap = await raw(page);
  await page.fill("#backupPassword", PASS);
  await page.fill("#backupPassword2", PASS + "x");
  await page.click("#exportEncryptedBtn");
  await waitFor(async () => (await msg(page)).state === "error", "پیام خطای ناهمخوانی");
  assert.match((await msg(page)).text, /یکی نیستند/);

  await page.fill("#backupPassword", "1234567");
  await page.fill("#backupPassword2", "1234567");
  await page.click("#exportEncryptedBtn");
  await waitFor(async () => /حداقل ۸/.test((await msg(page)).text), "پیام گذرواژه‌ی کوتاه");
  assert.equal(await raw(page), snap, "هیچ‌چیز ذخیره‌ی داده‌ها تغییر نکرد");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedDialogs, []);
});

test("دانلود رمزشده: فایل بدون متن ساده است و با گذرواژه‌ی درست بررسی می‌شود", async () => {
  const { page, errors } = await openApp();
  await page.fill("#backupPassword", PASS);
  await page.fill("#backupPassword2", PASS);
  const dl = await download(page, "#exportEncryptedBtn");
  assert.equal(dl.name, "dokhtyar-backup-encrypted.json");
  assert.equal(dl.text.includes(CUSTOMER), false, "نام مشتری نباید در فایل رمزشده باشد");
  assert.equal(dl.text.includes(PHONE), false, "شماره تماس نباید در فایل رمزشده باشد");
  const obj = JSON.parse(dl.text);
  assert.equal(obj.format, "dokhtyar-encrypted-backup");
  assert.equal(obj.version, 1);
  // گذرواژه‌ی فیلدها پس از دانلود پاک می‌شود
  assert.equal(await page.inputValue("#backupPassword"), "");
  assert.equal(await page.inputValue("#backupPassword2"), "");

  const snap = await raw(page);
  await page.setInputFiles("#backupCheckFile", dl.file);
  await page.fill("#backupCheckPassword", PASS);
  await page.click("#backupCheckBtn");
  await waitFor(async () => /فایل رمزشده معتبر است/.test((await msg(page)).text), "پیام معتبر بودن");
  const result = await msg(page);
  assert.equal(result.state, "ok");
  assert.match(result.text, /هیچ داده‌ای تغییر نکرد/);
  assert.equal(await raw(page), snap, "بررسی فایل داده‌ی برنامه را تغییر نمی‌دهد");
  assert.deepEqual(errors, []);
});

test("گذرواژه‌ی نادرست و فایل خراب: خطای روشن، و هیچ داده‌ای تغییر نمی‌کند", async () => {
  const { page, errors } = await openApp();
  await page.fill("#backupPassword", PASS);
  await page.fill("#backupPassword2", PASS);
  const dl = await download(page, "#exportEncryptedBtn");
  const snap = await raw(page);

  await page.setInputFiles("#backupCheckFile", dl.file);
  await page.fill("#backupCheckPassword", PASS + "-غلط");
  await page.click("#backupCheckBtn");
  await waitFor(async () => /گذرواژه نادرست/.test((await msg(page)).text), "پیام گذرواژه‌ی نادرست");
  assert.equal((await msg(page)).state, "error");

  const corruptFile = path.join(tmp, "corrupt.json");
  const obj = JSON.parse(dl.text);
  const bytes = Buffer.from(obj.data, "base64");
  bytes[5] ^= 0xff;
  obj.data = bytes.toString("base64");
  fs.writeFileSync(corruptFile, JSON.stringify(obj));
  await page.setInputFiles("#backupCheckFile", corruptFile);
  await page.fill("#backupCheckPassword", PASS);
  await page.click("#backupCheckBtn");
  await waitFor(async () => /گذرواژه نادرست است یا فایل خراب/.test((await msg(page)).text), "پیام فایل خراب");

  const badVersion = path.join(tmp, "v2.json");
  fs.writeFileSync(badVersion, JSON.stringify({ ...obj, version: 2 }));
  await page.setInputFiles("#backupCheckFile", badVersion);
  await page.click("#backupCheckBtn");
  await waitFor(async () => /نسخه‌ی 2/.test((await msg(page)).text), "پیام نسخه‌ی پشتیبانی‌نشده");

  assert.equal(await raw(page), snap, "هیچ‌کدام از بررسی‌های ناموفق داده را تغییر نداد");
  assert.deepEqual(errors, []);
});

test("پشتیبان ساده‌ی قدیمی همچنان دانلود و بررسی می‌شود", async () => {
  const { page, errors } = await openApp();
  const dl = await download(page, "#exportBtn");
  assert.equal(dl.name, "dokhtyar-backup.json");
  const data = JSON.parse(dl.text);
  assert.ok(data.customers.some((c) => c.name === CUSTOMER), "پشتیبان ساده همان داده را دارد");
  assert.ok(data.settings, "شکل محلی با settings");

  const snap = await raw(page);
  await page.setInputFiles("#backupCheckFile", dl.file);
  await page.click("#backupCheckBtn");
  await waitFor(async () => /فایل ساده معتبر است/.test((await msg(page)).text), "پیام پشتیبان ساده");
  assert.equal(await raw(page), snap);
  assert.deepEqual(errors, []);
});
