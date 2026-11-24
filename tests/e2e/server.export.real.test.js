// آزمون /export روی سرور واقعی و PostgreSQL (جاب e2e در CI). نیازمند:
//   E2E_BASE=http://127.0.0.1:3000  E2E_EMAIL=...  E2E_PASSWORD=...  (مدیر)
// اگر متغیرها نباشند، آزمون‌ها رد (skip) می‌شوند.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE || "http://127.0.0.1:3000";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const SKIP = !EMAIL || !PASSWORD ? "E2E_EMAIL و E2E_PASSWORD لازم است" : false;
const PASS = "گذرواژه-سرور-واقعی-۱۲۳";
// هر نشست نام و شماره‌ی تازه دارد: شماره در هر مزون یکتا است و تکرار، ثبت را رد می‌کند
let CUSTOMER = "";
let PHONE = "";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dokhtyar-realexport-"));

let browser;
const contexts = [];
before(async () => { if (!SKIP) browser = await chromium.launch(); });
after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openAsAdmin() {
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  CUSTOMER = "مشتری-اکسپورت-" + tag;
  PHONE = "0912" + String(Math.floor(1000000 + Math.random() * 8999999));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  await ctx.addInitScript(() => { window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" }; });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/index.html");
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', EMAIL);
  await page.fill('#loginForm input[name="password"]', PASSWORD);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await sleep(400);
  // یک مشتری می‌سازیم تا در خروجی دیده شود
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', CUSTOMER);
  await page.fill('#customerForm input[name="phone"]', PHONE);
  await page.click('#customerForm button[type="submit"]');
  await page.waitForFunction((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), CUSTOMER, { timeout: 8000 });
  await page.click('.nav-item[data-page="settings"]');
  return { page, errors };
}

async function download(page, selector) {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), page.click(selector)]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(file, "utf8") };
}

test("سرور واقعی: پشتیبان ساده شکل سرور دارد و مشتری را شامل می‌شود", { skip: SKIP }, async () => {
  const { page, errors } = await openAsAdmin();
  const dl = await download(page, "#exportBtn");
  const data = JSON.parse(dl.text);
  assert.ok(typeof data.exported_at === "string");
  assert.ok(data.shop && typeof data.shop === "object");
  for (const k of ["customers", "orders", "staff", "transactions"]) assert.ok(Array.isArray(data[k]), k + " فهرست است");
  assert.ok(data.customers.some((c) => c.name === CUSTOMER), "مشتری تازه در خروجی سرور است");
  assert.deepEqual(errors, []);
});

test("سرور واقعی: پشتیبان رمزشده با گذرواژه‌ی درست همان داده را برمی‌گرداند", { skip: SKIP }, async () => {
  const { page, errors } = await openAsAdmin();
  await page.fill("#backupPassword", PASS);
  await page.fill("#backupPassword2", PASS);
  const dl = await download(page, "#exportEncryptedBtn");
  assert.equal(dl.text.includes(CUSTOMER), false, "نام مشتری در فایل رمزشده نیست");
  const inner = await page.evaluate(async ([text, pw]) => {
    const r = await BackupCrypto.decryptBackup(text, pw);
    return { kind: r.kind, names: r.data.customers.map((c) => c.name) };
  }, [dl.text, PASS]);
  assert.equal(inner.kind, "server");
  assert.ok(inner.names.includes(CUSTOMER));
  assert.deepEqual(errors, []);
});
