// تست مرورگری رمزنگاری حالت محلی (localStorage: dokhtyar.v2 → dokhtyar.v3).
// کلید غیرقابل استخراج در IndexedDB «dokhtyar-vault» است. حالت سرور در این تست اجرا نمی‌شود.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const V2 = "dokhtyar.v2";
const V3 = "dokhtyar.v3";
const VAULT = "dokhtyar-vault";

const LOCK_KEY_MISSING = "کلید رمزنگاری این مرورگر پیدا نشد.";
const PHONE = "09121234567";

const legacy = (names) => JSON.stringify({
  orders: [],
  customers: names.map((n, i) => ({ name: n, phone: "0912000000" + i, note: "یادداشت-" + n })),
  staff: [],
  transactions: [],
  settings: { shopName: "مزون قدیمی", ownerName: "", phone: "", address: "", currency: "تومان" },
});

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
  assert.deepEqual(pageErrors, [], 'هیچ خطای صفحه‌ای نباید رخ دهد');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err; // صفحه ممکن است در حال بارگذاری مجدد باشد
    }
    await sleep(100);
  }
  throw new Error("زمان انتظار تمام شد: " + label + (last ? " (" + last.message + ")" : ""));
}

// هر سناریو کانتکست جداگانه (localStorage و IndexedDB جدا) دارد.
// seedV2: داده‌ی ساده‌ی قدیمی قبل از بارگذاری برنامه؛ failV3: نوشتن dokhtyar.v3 همیشه شکست می‌خورد.
async function openApp({ seedV2, failV3 = false, dialogs = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  if (failV3) {
    await ctx.addInitScript(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === "dokhtyar.v3") throw new DOMException("quota", "QuotaExceededError");
        return orig.call(this, k, v);
      };
    });
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const unexpected = [];
  const plan = [...dialogs];
  page.on("dialog", async (d) => {
    const step = plan.shift();
    if (!step) { unexpected.push(d.message()); return d.dismiss(); }
    if (d.type() === "prompt") return step.text === undefined ? d.dismiss() : d.accept(step.text);
    return step.ok ? d.accept() : d.dismiss();
  });
  if (seedV2 !== undefined) {
    // روی همان مبدأ (manifest) داده را می‌نویسیم، سپس برنامه را باز می‌کنیم
    await page.goto(base + "/manifest.webmanifest");
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [V2, seedV2]);
  }
  await page.goto(base + "/index.html");
  await waitFor(() => page.evaluate(() => document.readyState === "complete"), "بارگذاری صفحه");
  return { page, plan, unexpected };
}

const raw = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const lockVisible = (page) => page.evaluate(() => !document.querySelector("#localLock").hidden);

async function addCustomer(page, name) {
  await showCustomers(page);
  await page.click("#addCustomerBtn");
  await page.fill("#customerForm input[name=name]", name);
  await page.fill("#customerForm input[name=phone]", PHONE);
  await page.click("#customerForm button[type=submit]");
  await waitFor(() => page.evaluate((n) => document.querySelector("#customersBody")?.textContent.includes(n) || false, name), "نمایش مشتری " + name);
}

async function showCustomers(page) {
  await page.click('.nav-item[data-page="customers"]');
}

test('راه‌اندازی تازه: بدون قفل و بدون نوشتن داده‌ی ساده', async () => {
  const { page } = await openApp();
  await waitFor(() => lockVisible(page).then((v) => v === false), "نبود قفل");
  assert.equal(await raw(page, V3), null, 'در راه‌اندازی تازه چیزی رمز نمی‌شود');
  assert.equal(await raw(page, V2), null);
});

test('افزودن مشتری: پاکت رمزشده است و بعد از بارگذاری دوباره نمایش داده می‌شود', async () => {
  const { page } = await openApp();
  await addCustomer(page, 'مریم-محرمانه-آزمون');
  await waitFor(async () => (await raw(page, V3)) !== null, "نوشتن پاکت v3");
  const sealed = await raw(page, V3);
  assert.equal(sealed.includes('مریم-محرمانه-آزمون'), false, 'نام مشتری در متن ساده نیست');
  assert.equal(sealed.includes(PHONE), false, 'شماره تماس در متن ساده نیست');

  await page.reload();
  await waitFor(() => lockVisible(page).then((v) => v === false), "باز شدن بدون قفل");
  await showCustomers(page);
  await waitFor(() => page.evaluate(() => document.querySelector("#customersBody").textContent.includes("مریم-محرمانه-آزمون")), "داده بعد از بارگذاری");
});

test('مهاجرت از نسخه‌ی ساده: همه‌ی مشتری‌ها حفظ می‌شوند و نسخه‌ی ساده فقط بعد از تأیید حذف می‌شود', async () => {
  const { page } = await openApp({ seedV2: legacy(['الف-قدیمی', 'ب-قدیمی']) });
  await waitFor(async () => (await raw(page, V2)) === null, "حذف نسخه‌ی ساده بعد از تأیید");
  assert.notEqual(await raw(page, V3), null, 'نسخه‌ی رمزشده نوشته شده');
  assert.equal((await raw(page, V3)).includes('الف-قدیمی'), false);

  // داده‌ی خوانده‌شده از پاکت باید دقیقاً همان دو مشتری باشد
  const plain = await page.evaluate(() => LocalStore.readPlain());
  assert.deepEqual(plain.customers.map((c) => c.name), ['الف-قدیمی', 'ب-قدیمی']);
  assert.equal(plain.customers[1].note, 'یادداشت-ب-قدیمی');
  assert.equal(plain.settings.shopName, 'مزون قدیمی');

  await page.reload();
  await showCustomers(page);
  await waitFor(() => page.evaluate(() => {
    const t = document.querySelector("#customersBody").textContent;
    return t.includes("الف-قدیمی") && t.includes("ب-قدیمی");
  }), "نمایش هر دو مشتری بعد از مهاجرت");
});

test('خطای نوشتن در مهاجرت: نسخه‌ی ساده دست‌نخورده می‌ماند و داده در برنامه هست', async () => {
  const { page } = await openApp({ seedV2: legacy(['ایمن-بماند']), failV3: true });
  await showCustomers(page);
  await waitFor(() => page.evaluate(() => document.querySelector("#customersBody").textContent.includes("ایمن-بماند")), "نمایش داده‌ی ساده");
  assert.notEqual(await raw(page, V2), null, 'نسخه‌ی ساده نباید حذف شود');
  assert.equal(await raw(page, V3), null, 'پاکت رمزشده نوشته نشده');
});

test('کلید گم شده: قفل با دلیل روشن، بدون نوشتن و بدون ساخت کلید تازه', async () => {
  const { page } = await openApp();
  await addCustomer(page, 'قفل-آزمون');
  await waitFor(async () => (await raw(page, V3)) !== null, "پاکت v3");
  const before = await raw(page, V3);

  await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase("dokhtyar-vault");
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("حذف مسدود شد"));
  }));
  await page.reload();
  await waitFor(() => lockVisible(page), "نمایش قفل");
  assert.equal(await page.textContent("#localLockReason"), LOCK_KEY_MISSING);
  assert.equal(await raw(page, V3), before, 'پاکت دست‌نخورده است');

  const keyCount = await page.evaluate(() => new Promise((res) => {
    const open = indexedDB.open("dokhtyar-vault");
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("keys")) { db.close(); return res(0); }
      const g = db.transaction("keys", "readonly").objectStore("keys").count();
      g.onsuccess = () => { db.close(); res(g.result); };
    };
    open.onerror = () => res(-1);
  }));
  assert.equal(keyCount, 0, 'هیچ کلید تازه‌ای ساخته نشده است');
});

test('حذف داده‌ی ناخوانا: لغو یا متن اشتباه چیزی را حذف نمی‌کند؛ با دو تأیید درست حذف می‌شود', async () => {
  const { page, plan, unexpected } = await openApp();
  await addCustomer(page, 'برای-حذف');
  await waitFor(async () => (await raw(page, V3)) !== null, "پاکت v3");
  await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase("dokhtyar-vault");
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("حذف مسدود شد"));
  }));
  await page.reload();
  await waitFor(() => lockVisible(page), "نمایش قفل");
  const sealed = await raw(page, V3);

  // ۱) لغو در تأیید اول
  plan.push({ ok: false });
  await page.click("#localDeleteBtn");
  await sleep(300);
  assert.equal(await raw(page, V3), sealed, 'لغو اول: چیزی حذف نشد');

  // ۲) تأیید اول، اما متن دوم اشتباه
  plan.push({ ok: true }, { text: 'نه' });
  await page.click("#localDeleteBtn");
  await sleep(300);
  assert.equal(await raw(page, V3), sealed, 'متن اشتباه: چیزی حذف نشد');

  // ۳) تأیید کامل: پاکت ناخوانا حذف و صفحه بازخوانی می‌شود
  plan.push({ ok: true }, { text: 'حذف' });
  await page.click("#localDeleteBtn");
  await waitFor(async () => (await raw(page, V3)) === null, "حذف پاکت ناخوانا");
  await waitFor(() => lockVisible(page).then((v) => v === false), "برگشت برنامه بدون قفل");
  assert.deepEqual(plan, [], 'همه‌ی پرسش‌ها پاسخ داده شدند');
  assert.deepEqual(unexpected, [], 'پرسش ناخواسته‌ای نباید باشد');

  // بعد از حذف برنامه دوباره کار می‌کند
  await addCustomer(page, 'تازه-بعد-حذف');
  await waitFor(async () => (await raw(page, V3)) !== null, "نوشتن دوباره");
});

test('داده‌ی قابل‌خواندن هرگز حذف نمی‌شود', async () => {
  const { page } = await openApp();
  await addCustomer(page, 'قابل-خواندن');
  await waitFor(async () => (await raw(page, V3)) !== null, "پاکت v3");
  const sealed = await raw(page, V3);
  const message = await page.evaluate(async () => {
    try { await LocalStore.deleteUnreadable(); return "removed"; }
    catch (err) { return err.message; }
  });
  assert.match(message, /قابل‌خواندن/);
  assert.equal(await raw(page, V3), sealed, 'داده‌ی قابل‌خواندن سر جایش است');
});

test('پشتیبان JSON همچنان دانلود می‌شود و مشتری‌ها را دارد', async () => {
  const { page } = await openApp();
  await addCustomer(page, 'پشتیبان-آزمون');
  await page.click('.nav-item[data-page="settings"]');
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportBtn"),
  ]);
  assert.equal(download.suggestedFilename(), "dokhtyar-backup.json");
  const file = await download.path();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(data.customers.some((c) => c.name === "پشتیبان-آزمون"), 'مشتری در پشتیبان است');
});
