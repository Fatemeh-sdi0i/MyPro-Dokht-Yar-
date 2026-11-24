// تست مرورگری بازگردانی از فایل پشتیبان (ساده و رمزشده) در حالت محلی.
// هر سناریو زمینه‌ی جدا دارد؛ داده‌ی فعلی پیش از بازگردانی باید در پشتیبان محافظت‌شده بماند.
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
const BACKUP = "dokhtyar.backup.v3";
const BACKUP_AAD = "dokhtyar.local.backup";
const PASS = "گذرواژه-بازگردانی-۱۲۳";
const PHONE = "09121234567";
const FIRST = "مشتری-اولیه";
const LATER = "مشتری-بعد-از-فایل";

let server, base, browser;
const contexts = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dokhtyar-restore-"));

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

async function openApp(dialogs = []) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const plan = [...dialogs];
  const unexpected = [];
  page.on("dialog", async (d) => {
    const step = plan.shift();
    if (!step) { unexpected.push(d.message()); return d.dismiss(); }
    if (d.type() === "prompt") return step.text === undefined ? d.dismiss() : d.accept(step.text);
    return step.ok ? d.accept() : d.dismiss();
  });
  await page.goto(base + "/index.html");
  await waitFor(() => page.evaluate(() => document.readyState === "complete"), "بارگذاری صفحه");
  return { ctx, page, errors, unexpected };
}

async function addCustomer(page, name) {
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill("#customerForm input[name=name]", name);
  await page.fill("#customerForm input[name=phone]", PHONE);
  await page.click("#customerForm button[type=submit]");
  await waitFor(() => page.evaluate((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), name), "نمایش " + name);
  await page.click('.nav-item[data-page="settings"]');
}

async function download(page, selector) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(selector)]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}

const raw = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const msg = (page) => page.evaluate(() => ({ text: document.querySelector("#backupMsg").textContent, state: document.querySelector("#backupMsg").dataset.state }));
const restoreVisible = (page) => page.evaluate(() => !document.querySelector("#backupRestoreBtn").hidden);
const restoreDisabled = (page) => page.evaluate(() => document.querySelector("#backupRestoreBtn").disabled);
const customerNames = (page) => page.evaluate(() => (typeof state !== "undefined" ? state.customers.map((c) => c.name) : []));
const backupHolds = (page, name) => page.evaluate(async ([name, bak, aad]) => {
  const env = localStorage.getItem(bak);
  if (!env) return false;
  try {
    const text = await LocalStore.testing.openAny(env, aad);
    return JSON.parse(text).customers.some((c) => c.name === name);
  } catch (e) { return false; }
}, [name, BACKUP, BACKUP_AAD]);

async function check(page, file, password) {
  await page.setInputFiles("#backupCheckFile", file);
  if (password !== undefined) await page.fill("#backupCheckPassword", password);
  await page.click("#backupCheckBtn");
}

test("بازگردانی از فایل ساده: داده‌ی فعلی در پشتیبان محافظت‌شده می‌ماند و بازگردانی دوم رد می‌شود", async () => {
  const { page, errors, unexpected } = await openApp([
    { ok: true }, // تأیید بازگردانی
    { text: "بازگردانی" },
  ]);
  await addCustomer(page, FIRST);
  const file = await download(page, "#exportBtn"); // فایل شامل FIRST است

  await addCustomer(page, LATER); // داده‌ی فعلی: FIRST و LATER
  await check(page, file);
  await waitFor(async () => /فایل ساده معتبر است/.test((await msg(page)).text), "بررسی فایل");
  assert.equal(await restoreVisible(page), true, "دکمه‌ی بازگردانی برای فایل معتبر محلی دیده می‌شود");

  await page.click("#backupRestoreBtn");
  await waitFor(async () => /بازگردانی شد/.test((await msg(page)).text), "پیام موفقیت");
  assert.equal((await customerNames(page)).includes(LATER), false, "مشتری بعد از فایل حذف شده");
  assert.ok((await customerNames(page)).includes(FIRST));
  assert.equal(await backupHolds(page, LATER), true, "داده‌ی قبلی در پشتیبان محافظت‌شده است");

  // بازگردانی دوم: پشتیبان هست، پس دکمه غیرفعال و دلیل نشان داده می‌شود
  await page.click('.nav-item[data-page="settings"]');
  await check(page, file);
  await waitFor(async () => (await restoreVisible(page)) && (await restoreDisabled(page)), "غیرفعال شدن بازگردانی دوم");
  assert.match(await page.textContent("#backupRestoreNote"), /پشتیبان محافظت‌شده از قبل/);
  assert.equal(await backupHolds(page, LATER), true, "پشتیبان دست‌نخورده است");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
});

test("فایل رمزشده: گذرواژه‌ی نادرست بازگردانی را نمی‌دهد؛ گذرواژه‌ی درست بازگردانی می‌کند", async () => {
  const { page, errors, unexpected } = await openApp([{ ok: true }, { text: "بازگردانی" }]);
  await addCustomer(page, FIRST);
  await page.fill("#backupPassword", PASS);
  await page.fill("#backupPassword2", PASS);
  const file = await download(page, "#exportEncryptedBtn");
  await addCustomer(page, LATER);
  const snap = await raw(page, V3);

  await check(page, file, PASS + "-غلط");
  await waitFor(async () => /گذرواژه نادرست/.test((await msg(page)).text), "گذرواژه‌ی نادرست");
  assert.equal(await restoreVisible(page), false, "بدون بررسی موفق بازگردانی نیست");
  assert.equal(await raw(page, V3), snap, "گذرواژه‌ی نادرست داده را تغییر نداد");

  await page.click('.nav-item[data-page="settings"]');
  await check(page, file, PASS);
  await waitFor(async () => /فایل رمزشده معتبر است/.test((await msg(page)).text), "بررسی رمزشده");
  await page.click("#backupRestoreBtn");
  await waitFor(async () => /بازگردانی شد/.test((await msg(page)).text), "بازگردانی رمزشده");
  assert.ok((await customerNames(page)).includes(FIRST));
  assert.equal((await customerNames(page)).includes(LATER), false);
  assert.equal(await backupHolds(page, LATER), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
});

test("فایل حالت سرور در حالت محلی بازگردانی نمی‌شود و داده تغییر نمی‌کند", async () => {
  const { page, errors } = await openApp();
  const serverFile = path.join(tmp, "server-shape.json");
  fs.writeFileSync(serverFile, JSON.stringify({
    exported_at: "2026-11-24T06:00:00.000Z",
    shop: { shop_name: "سرور" },
    customers: [{ id: "c1", name: "مشتری-سرور", phone: "", note: "" }],
    orders: [], staff: [], transactions: [],
  }));
  await page.click('.nav-item[data-page="settings"]');
  const snap = await raw(page, V3);
  await check(page, serverFile);
  await waitFor(async () => /حالت سرور/.test((await msg(page)).text), "پیام حالت سرور");
  assert.equal(await restoreVisible(page), false, "بازگردانی حالت سرور نشان داده نمی‌شود");
  assert.equal(await raw(page, V3), snap);
  assert.equal(await raw(page, BACKUP), null);
  assert.deepEqual(errors, []);
});

test("بازگردانی داده‌ی نمونه: داده‌ی فعلی در پشتیبان می‌ماند؛ بار دوم با پیام روشن رد می‌شود", async () => {
  const { page, errors, unexpected } = await openApp([{ ok: true }]);
  await addCustomer(page, FIRST);
  assert.ok((await customerNames(page)).includes(FIRST));

  await page.click("#resetBtn"); // تأیید اول
  await waitFor(async () => !(await customerNames(page)).includes(FIRST), "بازگشت به داده‌ی نمونه");
  assert.equal(await backupHolds(page, FIRST), true, "داده‌ی پیش از بازگردانی نمونه در پشتیبان محافظت‌شده است");

  // بار دوم: پشتیبان هست؛ هیچ تأیید یا تغییری نباید رخ دهد
  await page.click("#resetBtn");
  await waitFor(async () => /پشتیبان محافظت‌شده از قبل/.test(await page.textContent("#toast")), "پیام رد بازگردانی دوم");
  assert.equal(await backupHolds(page, FIRST), true, "پشتیبان دست‌نخورده است");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
});
