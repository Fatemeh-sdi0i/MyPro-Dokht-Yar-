// آزمون سازگاری مرورگر: ذخیره‌ی رمزشده با کلید غیرقابل استخراج در IndexedDB، ماندگاری پس از بارگذاری مجدد،
// و پشتیبان رمزشده. با متغیر BROWSER یکی از chromium | firefox | webkit اجرا می‌شود.
// در این محیط فقط Chromium نصب است؛ Firefox و WebKit در جاب CI «browser-compat» نصب و اجرا می‌شوند.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const playwright = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const ENGINE = process.env.BROWSER || "chromium";
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const CUSTOMER = "مشتری-سازگاری-۱";
const PASS = "گذرواژه-سازگاری-۱۲۳";
const PHONE = "09121234567";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dokhtyar-compat-"));

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
  browser = await playwright[ENGINE].launch();
});

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error("زمان انتظار تمام شد: " + label);
}

async function open(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/index.html");
  await waitFor(() => page.evaluate(() => document.readyState === "complete"), "بارگذاری");
  return { page, errors };
}

test(`[${ENGINE}] ذخیره‌ی رمزشده پس از بارگذاری مجدد خوانده می‌شود`, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  const { page, errors } = await open(ctx);
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill("#customerForm input[name=name]", CUSTOMER);
  await page.fill("#customerForm input[name=phone]", PHONE);
  await page.click("#customerForm button[type=submit]");
  await waitFor(() => page.evaluate((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), CUSTOMER), "نمایش مشتری");
  await waitFor(() => page.evaluate(() => localStorage.getItem("dokhtyar.v3") !== null), "نوشتن رمزشده");

  const stored = await page.evaluate(() => localStorage.getItem("dokhtyar.v3"));
  assert.equal(stored.includes(CUSTOMER), false, "نام مشتری به‌صورت متن ساده ذخیره نمی‌شود");
  assert.equal(stored.includes(PHONE), false, "شماره‌ی تماس به‌صورت متن ساده ذخیره نمی‌شود");

  // بارگذاری مجدد: کلید از IndexedDB خوانده و داده رمزگشایی می‌شود
  await page.reload();
  await waitFor(() => page.evaluate(() => document.readyState === "complete"), "بارگذاری مجدد");
  await page.click('.nav-item[data-page="customers"]');
  await waitFor(() => page.evaluate((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), CUSTOMER), "ماندگاری مشتری پس از بارگذاری مجدد");
  assert.deepEqual(errors, []);
});

test(`[${ENGINE}] پشتیبان رمزشده با گذرواژه‌ی درست برمی‌گردد و نادرست رد می‌شود`, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  const { page, errors } = await open(ctx);
  await page.click('.nav-item[data-page="settings"]');
  await page.fill("#backupPassword", PASS);
  await page.fill("#backupPassword2", PASS);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportEncryptedBtn")]);
  const file = path.join(tmp, `${ENGINE}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  const text = fs.readFileSync(file, "utf8");

  const result = await page.evaluate(async (t) => {
    const ok = await BackupCrypto.decryptBackup(t, "گذرواژه-سازگاری-۱۲۳");
    let bad = null;
    try { await BackupCrypto.decryptBackup(t, "گذرواژه-اشتباه-۱۲۳"); } catch (e) { bad = e.code; }
    return { kind: ok.kind, bad };
  }, text);
  assert.equal(result.kind, "local");
  assert.equal(result.bad, "decrypt_failed");
  assert.deepEqual(errors, []);
});
