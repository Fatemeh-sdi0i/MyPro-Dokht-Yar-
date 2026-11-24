// آزمون بازگردانی از فایل روی سرور واقعی و PostgreSQL (جاب e2e در CI). نیازمند:
//   E2E_BASE, E2E_EMAIL, E2E_PASSWORD (مدیر). بدون آن‌ها آزمون‌ها رد (skip) می‌شوند.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dokhtyar-realrestore-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
const contexts = [];
let shared = null;
before(async () => { if (!SKIP) browser = await chromium.launch(); });
after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// یک ورود برای کل فایل: سرور تعداد تلاش ورود را محدود می‌کند
async function session() {
  if (!shared) shared = await openAsAdmin();
  return shared;
}

async function openAsAdmin() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  await ctx.addInitScript(() => { window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" }; });
  const page = await ctx.newPage();
  page.on("dialog", (d) => (d.type() === "prompt" ? d.accept("بازگردانی") : d.accept()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/index.html");
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', EMAIL);
  await page.fill('#loginForm input[name="password"]', PASSWORD);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await sleep(400);
  return { page, errors };
}

async function exportJson(page) {
  await page.click('.nav-item[data-page="settings"]');
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), page.click("#exportBtn")]);
  const file = path.join(tmp, "export-" + Date.now() + ".json");
  await dl.saveAs(file);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function restoreFromText(page, text, name) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, text, "utf8");
  await page.click('.nav-item[data-page="settings"]');
  await page.setInputFiles("#backupCheckFile", file);
  await page.click("#backupCheckBtn");
  await page.waitForFunction(() => !document.querySelector("#backupRestoreBtn").hidden, null, { timeout: 8000 });
  await page.click("#backupRestoreBtn");
  await sleep(1200);
}

test("سرور واقعی: بازگردانی فایل سالم و نسخه‌ی پیش از بازگردانی", { skip: SKIP }, async () => {
  const { page, errors } = await session();
  const before1 = await exportJson(page);
  const marker = "بازگردانی-واقعی-" + Date.now().toString(36);
  // تغییر: یک مشتری تازه که پس از بازگردانی نباید بماند
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', marker);
  await page.fill('#customerForm input[name="phone"]', "0913" + String(Math.floor(1000000 + Math.random() * 8999999)));
  await page.click('#customerForm button[type="submit"]');
  await page.waitForFunction((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), marker, { timeout: 8000 });

  // بازگردانی از فایل سالم: نسخه‌ی پیش از آن را در سرور باید پیدا کنیم
  const { exported_at, ...rest } = before1;
  await restoreFromText(page, JSON.stringify(rest), "restore-valid.json");
  const after1 = await exportJson(page);
  assert.equal(after1.customers.some((c) => c.name === marker), false, "مشتری تازه پس از بازگردانی نیست");
  assert.equal(after1.customers.length, before1.customers.length);
  assert.deepEqual(errors, []);
});

test("سرور واقعی: فایل دست‌کاری‌شده رد می‌شود و داده تغییر نمی‌کند", { skip: SKIP }, async () => {
  const { page, errors } = await session();
  const current = await exportJson(page);
  const tampered = JSON.parse(JSON.stringify(current));
  delete tampered.exported_at;
  if (tampered.orders[0]) tampered.orders[0].price = -1;
  else tampered.transactions.push({ id: "00000000-0000-4000-8000-0000000000ee", kind: "income", category: "x", amount: 0.5, occurred_on: "2026-11-01", note: "", deleted_at: null });
  await restoreFromText(page, JSON.stringify(tampered), "restore-tampered.json");
  await sleep(800);
  const after2 = await exportJson(page);
  assert.equal(after2.customers.length, current.customers.length);
  assert.equal(after2.orders.length, current.orders.length);
  assert.equal(after2.transactions.length, current.transactions.length);
  assert.deepEqual(errors, []);
});

test("سرور واقعی: نسخه‌ی پیش از بازگردانی دانلود می‌شود", { skip: SKIP }, async () => {
  const { page, errors } = await session();
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForSelector("#downloadSnapshotBtn:not([hidden])", { timeout: 8000 });
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), page.click("#downloadSnapshotBtn")]);
  const file = path.join(tmp, "snapshot.json");
  await dl.saveAs(file);
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(snap.customers) && Array.isArray(snap.status_log));
  assert.deepEqual(errors, []);
});

test("سرور واقعی: حذف تراکنش و بازگردانی آن", { skip: SKIP }, async () => {
  const { page, errors } = await session();
  const amount = 123000 + Math.floor(Math.random() * 1000);
  await page.click('.nav-item[data-page="finance"]');
  await page.click("#addTxBtn");
  await page.selectOption('#txForm select[name="kind"]', "expense");
  await page.selectOption('#txForm select[name="category"]', "سایر");
  await page.fill('#txForm input[name="amount"]', String(amount));
  await page.fill('#txForm input[name="note"]', "آزمون-واقعی");
  await page.click('#txForm button[type="submit"]');
  await page.waitForFunction((a) => document.querySelector("#txBody, table tbody") && document.body.textContent.includes("آزمون-واقعی"), amount, { timeout: 8000 });
  await page.locator('[data-delete-tx]').first().waitFor({ timeout: 8000 });
  await page.locator("tr", { hasText: "آزمون-واقعی" }).locator("[data-delete-tx]").click();
  await sleep(800);
  await page.click("#txDeletedWrap summary");
  const restore = page.locator("#txDeletedBody [data-restore-tx]").first();
  await restore.waitFor({ timeout: 8000 });
  await restore.click();
  await sleep(600);
  const data = await exportJson(page);
  const found = data.transactions.find((t) => t.note === "آزمون-واقعی" && t.amount === amount);
  assert.ok(found && !found.deleted_at, "تراکنش پس از بازگردانی فعال است");
  assert.deepEqual(errors, []);
});
