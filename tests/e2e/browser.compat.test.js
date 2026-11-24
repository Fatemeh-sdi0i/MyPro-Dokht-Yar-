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
  await waitFor(() => page.evaluate(() => document.body.dataset.ready === "true"), "آماده شدن برنامه");
  return { page, errors };
}

test(`[${ENGINE}] ذخیره‌ی رمزشده پس از بارگذاری مجدد؛ یا حالت فقط‌نشست با هشدار اگر مرورگر کلید را نگه ندارد`, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  const { page, errors } = await open(ctx);
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill("#customerForm input[name=name]", CUSTOMER);
  await page.fill("#customerForm input[name=phone]", PHONE);
  await page.click("#customerForm button[type=submit]");
  await waitFor(() => page.evaluate((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), CUSTOMER), "نمایش مشتری");
  // نتیجه‌ی واقعی مرورگر: یا کلید پایدار است و داده رمزشده نوشته می‌شود، یا حالت فقط‌نشست با هشدار
  await waitFor(() => page.evaluate(() => LocalStore.getStatus().sessionOnly === true || localStorage.getItem("dokhtyar.v3") !== null), "نتیجه‌ی ذخیره");

  const outcome = await page.evaluate(() => ({
    sessionOnly: LocalStore.getStatus().sessionOnly === true,
    reason: LocalStore.getStatus().reason,
    banner: !document.querySelector("#sessionBanner").hidden,
    stored: localStorage.getItem("dokhtyar.v3"),
  }));

  if (outcome.sessionOnly) {
    // این مرورگر کلید غیرقابل استخراج را در IndexedDB نگه نمی‌دارد: هیچ‌چیز روی دیسک نمی‌رود و هشدار دیده می‌شود
    t.diagnostic(`${ENGINE}: کلید در IndexedDB نگهداری نمی‌شود (${outcome.reason || "فقط‌نشست"}). حالت فقط‌نشست فعال شد.`);
    assert.equal(outcome.stored, null, "در حالت فقط‌نشست هیچ پاکت رمزشده‌ای نوشته نمی‌شود");
    assert.equal(outcome.banner, true, "هشدار حالت فقط‌نشست نمایش داده می‌شود");
  } else {
    assert.equal(outcome.stored.includes(CUSTOMER), false, "نام مشتری به‌صورت متن ساده ذخیره نمی‌شود");
    assert.equal(outcome.stored.includes(PHONE), false, "شماره‌ی تماس به‌صورت متن ساده ذخیره نمی‌شود");
    // بارگذاری مجدد: کلید از IndexedDB خوانده و داده رمزگشایی می‌شود
    await page.reload();
    await waitFor(() => page.evaluate(() => document.body.dataset.ready === "true"), "بارگذاری مجدد");
    await page.click('.nav-item[data-page="customers"]');
    await waitFor(() => page.evaluate((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), CUSTOMER), "ماندگاری مشتری پس از بارگذاری مجدد");
  }
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

// دترمینیستیک: مرورگری که کلید را نمی‌تواند در IndexedDB بنویسد (DataCloneError) نباید معلق بماند یا خطای تکراری بدهد
test(`[${ENGINE}] اگر کلید در IndexedDB ذخیره نشود، حالت فقط‌نشست فعال می‌شود و نوشتن معلق نمی‌ماند`, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  await ctx.addInitScript(() => {
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "keys") throw new DOMException("The object can not be cloned.", "DataCloneError");
      return realPut.apply(this, args);
    };
  });
  const { page, errors } = await open(ctx);
  await waitFor(() => page.evaluate(() => LocalStore.getStatus().sessionOnly === true), "حالت فقط‌نشست");
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill("#customerForm input[name=name]", CUSTOMER);
  await page.fill("#customerForm input[name=phone]", PHONE);
  await page.click("#customerForm button[type=submit]");
  await waitFor(() => page.evaluate((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), CUSTOMER), "نمایش مشتری در حافظه");
  assert.equal(await page.evaluate(() => localStorage.getItem("dokhtyar.v3")), null, "هیچ پاکتی روی دیسک نیست");
  assert.equal(await page.evaluate(() => !document.querySelector("#sessionBanner").hidden), true, "هشدار دیده می‌شود");
  assert.equal(await page.evaluate(() => LocalStore.pendingCount()), 0, "نوشتنی معلق نمانده است");
  assert.deepEqual(errors, []);
});

// سازگاری APIها و طرح‌بندی موبایل: هر مرورگری (از جمله WebKit و Firefox) باید APIهای لازم را داشته باشد
// و صفحه در عرض موبایل بدون اسکرول افقی باشد.
test(`[${ENGINE}] APIهای لازم موجودند و طرح‌بندی موبایل بدون اسکرول افقی است`, async () => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: ENGINE !== "firefox",
    hasTouch: true,
    serviceWorkers: "allow",
  });
  contexts.push(ctx);
  const { page, errors } = await open(ctx);
  const caps = await page.evaluate(() => ({
    randomUUID: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function",
    subtle: typeof crypto !== "undefined" && !!crypto.subtle,
    indexedDB: typeof indexedDB !== "undefined",
    allSettled: typeof Promise.allSettled === "function",
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  assert.equal(caps.randomUUID, true, "crypto.randomUUID موجود است");
  assert.equal(caps.subtle, true, "WebCrypto (crypto.subtle) موجود است");
  assert.equal(caps.indexedDB, true, "IndexedDB موجود است");
  assert.equal(caps.allSettled, true, "Promise.allSettled موجود است");
  assert.ok(caps.overflowX <= 1, `بدون اسکرول افقی در موبایل (سرریز: ${caps.overflowX}px)`);
  assert.deepEqual(errors, []);
});
