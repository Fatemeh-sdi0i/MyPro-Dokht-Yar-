// آزمون مرورگری Undo (حذف و بازگردانی مشتری، سفارش و همکار) روی سرور واقعی و PostgreSQL (جاب e2e در CI).
// نیازمند: E2E_BASE (فقط میزبان محلی)، E2E_EMAIL و E2E_PASSWORD (مدیر پایگاه آزمایشی CI).
// داده‌ها فقط با پیشوند «undo-e2e-» و شماره‌تماس تصادفی ساخته می‌شوند و هیچ داده‌ی موجودی تغییر نمی‌کند.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE || "http://127.0.0.1:3000";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE);
// اگر سرور واقعی نباشد یا میزبان محلی نباشد، آزمون اجرا نمی‌شود تا داده‌ی زنده لمس نشود
const SKIP = !EMAIL || !PASSWORD ? "E2E_EMAIL و E2E_PASSWORD لازم است" : !LOCAL ? "فقط روی سرور محلی CI اجرا می‌شود" : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAG = "undo-e2e-" + Date.now().toString(36);
const phone = () => "0917" + String(Math.floor(1000000 + Math.random() * 8999999));

let browser;
const contexts = [];
let shared = null;
before(async () => { if (!SKIP) browser = await chromium.launch(); });
after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
});

// یک ورود برای کل فایل: سرور تعداد تلاش ورود را محدود می‌کند
async function session() {
  if (shared) return shared;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  await ctx.addInitScript(() => { window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" }; });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE + "/index.html");
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', EMAIL);
  await page.fill('#loginForm input[name="password"]', PASSWORD);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await sleep(400);
  shared = { page, errors };
  return shared;
}

// فراخوانی API با کوکی نشست همان مرورگر (همان مبدأ)، بدون دور زدن رابط
async function api(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const r = await fetch("/api/v1" + url, {
      method, credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* بدون بدنه */ }
    return { status: r.status, body: data };
  }, { method, url, body });
}

async function reloadApp(page) {
  await page.goto(BASE + "/index.html");
  await page.waitForSelector("body[data-ready]", { timeout: 8000 });
  await sleep(400);
}
// سطر سفارش با شماره‌ی سفارش شناسایی نمی‌شود؛ برای انتظار از دکمه‌ی همان سفارش استفاده می‌شود
const orderBtn = (page, attr, id) => page.locator(`[${attr}="${id}"]`);

const bodyText = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || "", sel);
const expand = (page, sel) => page.evaluate((s) => { const d = document.querySelector(s).closest("details"); if (d) d.open = true; }, sel);
async function waitText(page, sel, text, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if ((await bodyText(page, sel)).includes(text)) return;
    await sleep(150);
  }
  throw new Error("زمان انتظار تمام شد: " + label);
}

// داده‌ی آزمایشی: یک مشتری با دو سفارش و یک همکار، همه با پیشوند TAG
async function seed(page, label) {
  const cust = { id: crypto.randomUUID(), name: `${TAG}-${label}`, phone: phone() };
  const c = await api(page, "POST", "/customers", cust);
  assert.equal(c.status, 201, "ساخت مشتری آزمایشی: " + JSON.stringify(c.body));
  const o1 = { id: crypto.randomUUID(), customer_id: cust.id, type: "sewing", description: `${TAG}-پیراهن`, price: 100000 };
  const o2 = { id: crypto.randomUUID(), customer_id: cust.id, type: "repair", description: `${TAG}-کوتاهی`, price: 50000 };
  for (const o of [o1, o2]) {
    const r = await api(page, "POST", "/orders", o);
    assert.equal(r.status, 201, "ساخت سفارش آزمایشی: " + JSON.stringify(r.body));
  }
  return { cust, o1, o2 };
}

const findOrder = async (page, id) => (await api(page, "GET", "/orders")).body.items.find((o) => o.id === id);

test("سرور واقعی: حذف مشتری؛ سفارش‌ها باقی می‌مانند و تغییر وضعیت ۴۰۹ می‌دهد", { skip: SKIP }, async () => {
  const { page, errors } = await session();
  const { cust, o1 } = await seed(page, "الف");
  await reloadApp(page);

  await page.click('.nav-item[data-page="customers"]');
  await waitText(page, "#customersBody", cust.name, "نمایش مشتری آزمایشی");
  await page.click(`#customersBody [data-delete-customer="${cust.id}"]`);
  await waitText(page, "#custDeletedBody", cust.name, "مشتری در بخش حذف‌شده‌ها");

  // سفارش فعال بماند و پرچم customer_deleted روشن باشد
  const after = await findOrder(page, o1.id);
  assert.ok(after, "سفارش پس از حذف مشتری هنوز فعال است");
  assert.equal(after.customer_deleted, true);

  // تغییر وضعیت و ویرایش و حذف سفارش ۴۰۹ می‌دهند و هیچ‌چیز را تغییر نمی‌دهند
  const st = await api(page, "POST", `/orders/${o1.id}/status`, { to: "progress", version: after.version });
  assert.equal(st.status, 409);
  assert.equal(st.body.error, "customer_deleted");
  const patch = await api(page, "PATCH", `/orders/${o1.id}`, { description: "تغییر-نباید-ثبت-شود", version: after.version });
  assert.equal(patch.status, 409);
  assert.equal(patch.body.error, "customer_deleted");
  const del = await api(page, "DELETE", `/orders/${o1.id}?version=${after.version}`);
  assert.equal(del.status, 409);
  assert.equal(del.body.error, "customer_deleted");
  const same = await findOrder(page, o1.id);
  assert.equal(same.status, after.status, "وضعیت تغییر نکرد");
  assert.equal(same.version, after.version, "نسخه تغییر نکرد");
  assert.equal(same.description, after.description, "شرح تغییر نکرد");

  // سفارش‌ها در فهرست سفارش‌ها با برچسب «مشتری حذف شده» و بدون کنترل
  await page.click('.nav-item[data-page="orders"]');
  await waitText(page, "#ordersBody", "مشتری حذف شده", "برچسب مشتری حذف‌شده");
  const controls = await page.evaluate((name) => {
    const rows = [...document.querySelectorAll("#ordersBody tr")].filter((tr) => tr.textContent.includes(name));
    return rows.length ? rows.map((row) => ({ status: !!row.querySelector("[data-status-index]"), del: !!row.querySelector("[data-delete-order]") })) : null;
  }, cust.name);
  assert.ok(controls && controls.length === 2, "هر دو سطر سفارش مشتری پیدا شد");
  assert.deepEqual(controls, [{ status: false, del: false }, { status: false, del: false }]);
  assert.deepEqual(errors, []);
});

test("سرور واقعی: بازگردانی مشتری سفارش‌ها را خودکار برنمی‌گرداند؛ سفارش جدا بازگردانده می‌شود", { skip: SKIP }, async () => {
  const { page, errors } = await session();
  const { cust, o1, o2 } = await seed(page, "ب");
  await reloadApp(page);

  // سفارش دوم جداگانه حذف می‌شود
  await page.click('.nav-item[data-page="orders"]');
  await orderBtn(page, "data-delete-order", o2.id).waitFor({ timeout: 8000 });
  await orderBtn(page, "data-delete-order", o2.id).click();
  // بخش حذف‌شده‌ها بسته است؛ دکمه‌ی بازگردانی پیش از باز شدن پنهان است
  await orderBtn(page, "data-restore-order", o2.id).waitFor({ state: "attached", timeout: 8000 });

  // مشتری حذف و بازگردانی می‌شود
  await page.click('.nav-item[data-page="customers"]');
  await waitText(page, "#customersBody", cust.name, "نمایش مشتری");
  await page.click(`#customersBody [data-delete-customer="${cust.id}"]`);
  await waitText(page, "#custDeletedBody", cust.name, "مشتری حذف‌شده");
  await expand(page, "#custDeletedBody");
  await page.click(`#custDeletedBody [data-restore-customer="${cust.id}"]`);
  await waitText(page, "#customersBody", cust.name, "بازگشت مشتری");

  // سفارش حذف‌شده هنوز حذف است؛ سفارش دیگر فعال و قابل ویرایش
  const restoredOrder = await findOrder(page, o1.id);
  assert.equal(restoredOrder.customer_deleted, false, "پرچم پس از بازگردانی مشتری false است");
  const deletedList = (await api(page, "GET", "/orders/deleted")).body.items;
  assert.ok(deletedList.some((o) => o.id === o2.id), "سفارش حذف‌شده هنوز در فهرست حذف‌شده‌هاست");
  assert.equal(deletedList.some((o) => o.id === o1.id), false, "سفارش فعال خودکار برنگشته است");
  const st = await api(page, "POST", `/orders/${o1.id}/status`, { to: "progress", version: restoredOrder.version });
  assert.equal(st.status, 200, "پس از بازگردانی مشتری تغییر وضعیت مجاز است");

  // بازگردانی جداگانه‌ی سفارش از رابط
  await page.click('.nav-item[data-page="orders"]');
  await expand(page, "#orderDeletedBody");
  await orderBtn(page, "data-restore-order", o2.id).click();
  await orderBtn(page, "data-delete-order", o2.id).waitFor({ timeout: 8000 });
  const back = await findOrder(page, o2.id);
  assert.ok(back && back.customer_deleted === false, "سفارش پس از بازگردانی جداگانه فعال است");
  assert.deepEqual(errors, []);
});

test("سرور واقعی: حذف و بازگردانی همکار", { skip: SKIP }, async () => {
  const { page, errors } = await session();
  const name = `${TAG}-همکار`;
  const created = await api(page, "POST", "/staff", { id: crypto.randomUUID(), name, role_title: "خیاط", phone: phone() });
  assert.equal(created.status, 201, "ساخت همکار آزمایشی: " + JSON.stringify(created.body));
  const id = created.body.id;
  await reloadApp(page);

  await page.click('.nav-item[data-page="coworkers"]');
  await waitText(page, "#staffBody", name, "نمایش همکار");
  await page.click(`#staffBody [data-delete-staff="${id}"]`);
  await waitText(page, "#staffDeletedBody", name, "همکار حذف‌شده");
  const active = (await api(page, "GET", "/staff")).body.items.some((s) => s.id === id);
  assert.equal(active, false, "همکار حذف‌شده در فهرست فعال نیست");

  await expand(page, "#staffDeletedBody");
  await page.click(`#staffDeletedBody [data-restore-staff="${id}"]`);
  await waitText(page, "#staffBody", name, "بازگشت همکار");
  const back = (await api(page, "GET", "/staff")).body.items.some((s) => s.id === id);
  assert.equal(back, true, "همکار بازگردانده شد");
  assert.deepEqual(errors, []);
});
