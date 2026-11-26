// تست مرورگری حذف و بازگردانی مشتری، سفارش و همکار در حالت سرور (گام دوم Undo)؛ API ساختگی با همان شکل پاسخ مسیرهای واقعی.
// آزمون واقعی روی PostgreSQL در server.undo.real.test.js (جاب e2e در CI).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const ADMIN = { id: "u-admin", email: "admin@x.test", pw: "pw-admin-123", role: "admin" };
const UUID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const NOW = "2026-11-25T10:00:00.000Z";

let db;
function freshDb() {
  db = {
    session: null,
    shop: { shop_name: "مزون آزمون", owner_name: "مدیر", phone: "", address: "", currency: "تومان" },
    customers: [
      { id: UUID(1), name: "مشتری-یک", phone: "09121111111", note: "", tier: "regular", version: 1, deleted_at: null },
      { id: UUID(2), name: "مشتری-دو", phone: "09122222222", note: "", tier: "regular", version: 1, deleted_at: null },
    ],
    orders: [
      { id: UUID(5), order_no: 1, customer_id: UUID(1), customer_name: "مشتری-یک", customer_deleted: false, type: "sewing", description: "پیراهن", status: "new", price: 100000, created_on: "2026-11-20", due_on: null, version: 1, deleted_at: null },
      { id: UUID(6), order_no: 2, customer_id: UUID(2), customer_name: "مشتری-دو", customer_deleted: false, type: "repair", description: "کوتاهی", status: "new", price: 50000, created_on: "2026-11-21", due_on: null, version: 1, deleted_at: null },
    ],
    staff: [
      { id: UUID(7), name: "همکار-یک", role_title: "خیاط", phone: "", active: true, version: 1, deleted_at: null },
    ],
    transactions: [],
  };
}

// نمایش سفارش‌ها با وضعیت مشتری حذف‌شده، مانند پاسخ orderOut سرور
const orderOut = (o) => ({ ...o, customer_deleted: db.customers.some((c) => c.id === o.customer_id && c.deleted_at) });

function handle(method, url, body) {
  const [rawPath, query = ""] = url.replace("/api/v1", "").split("?");
  const u = rawPath;
  const reply = (code, obj) => ({ code, obj });
  if (method === "POST" && u === "/auth/login") {
    if (body.email !== ADMIN.email || body.password !== ADMIN.pw) return reply(401, { error: "invalid_credentials", message: "ایمیل یا گذرواژه درست نیست" });
    db.session = ADMIN;
    return reply(200, { user: { id: ADMIN.id, role: ADMIN.role } });
  }
  if (method === "POST" && u === "/auth/logout") { db.session = null; return reply(200, { ok: true }); }
  if (method === "GET" && u === "/auth/me") {
    return db.session ? reply(200, { user: { id: db.session.id, role: db.session.role } }) : reply(401, { error: "unauthorized", message: "ورود لازم است" });
  }
  if (!db.session) return reply(401, { error: "unauthorized", message: "ورود لازم است" });

  // مشتریان
  if (u === "/customers" && method === "GET") return reply(200, { items: db.customers.filter((c) => !c.deleted_at) });
  if (u === "/customers/deleted" && method === "GET") return reply(200, { items: db.customers.filter((c) => c.deleted_at).map((c) => ({ ...c, deleted_at: NOW })) });
  const custMatch = u.match(/^\/customers\/([^/]+)(\/restore)?$/);
  if (custMatch) {
    const c = db.customers.find((x) => x.id === custMatch[1]);
    if (!c) return reply(404, { error: "not_found", message: "مشتری پیدا نشد" });
    if (method === "DELETE" && !custMatch[2]) {
      if (c.deleted_at) return reply(404, { error: "not_found", message: "مشتری پیدا نشد" });
      c.deleted_at = NOW; c.version += 1;
      return reply(200, { ok: true });
    }
    if (method === "POST" && custMatch[2]) {
      if (!c.deleted_at) return reply(404, { error: "not_found", message: "مشتری حذف‌شده پیدا نشد" });
      c.deleted_at = null; c.version += 1;
      return reply(200, c);
    }
  }

  // سفارش‌ها
  if (u === "/orders" && method === "GET") return reply(200, { items: db.orders.filter((o) => !o.deleted_at).map(orderOut) });
  if (u === "/orders/deleted" && method === "GET") return reply(200, { items: db.orders.filter((o) => o.deleted_at).map((o) => ({ ...orderOut(o), deleted_at: NOW })) });
  const ordMatch = u.match(/^\/orders\/([^/]+)(\/restore)?$/);
  if (ordMatch) {
    const o = db.orders.find((x) => x.id === ordMatch[1]);
    if (!o) return reply(404, { error: "not_found", message: "سفارش پیدا نشد" });
    if (method === "DELETE" && !ordMatch[2]) {
      if (o.deleted_at) return reply(404, { error: "not_found", message: "سفارش پیدا نشد" });
      if (db.customers.find((c) => c.id === o.customer_id)?.deleted_at) return reply(409, { error: "customer_deleted", message: "مشتری این سفارش حذف شده است؛ تا بازگردانی مشتری، این سفارش فقط قابل مشاهده است" });
      o.deleted_at = NOW; o.version += 1;
      return reply(200, { ok: true });
    }
    if (method === "POST" && ordMatch[2]) {
      if (!o.deleted_at) return reply(404, { error: "not_found", message: "سفارش حذف‌شده پیدا نشد" });
      if (db.customers.find((c) => c.id === o.customer_id)?.deleted_at) return reply(409, { error: "customer_deleted", message: "ابتدا مشتری این سفارش را بازگردانید" });
      o.deleted_at = null; o.version += 1;
      return reply(200, orderOut(o));
    }
  }

  // همکاران
  if (u === "/staff" && method === "GET") return reply(200, { items: db.staff.filter((s) => !s.deleted_at) });
  if (u === "/staff/deleted" && method === "GET") return reply(200, { items: db.staff.filter((s) => s.deleted_at).map((s) => ({ ...s, deleted_at: NOW })) });
  const staffMatch = u.match(/^\/staff\/([^/]+)(\/restore)?$/);
  if (staffMatch) {
    const s = db.staff.find((x) => x.id === staffMatch[1]);
    if (!s) return reply(404, { error: "not_found", message: "همکار پیدا نشد" });
    if (method === "DELETE" && !staffMatch[2]) { s.deleted_at = NOW; s.version += 1; return reply(200, { ok: true }); }
    if (method === "POST" && staffMatch[2]) { s.deleted_at = null; s.version += 1; return reply(200, s); }
  }

  // بقیه‌ی مسیرهایی که صفحه هنگام بارگذاری می‌خواند
  if (u === "/transactions" && method === "GET") return reply(200, { items: [] });
  if (u === "/transactions/deleted" && method === "GET") return reply(200, { items: [] });
  if (u === "/settings" && method === "GET") return reply(200, { ...db.shop });
  if (u === "/export" && method === "GET") return reply(200, { exported_at: NOW, shop: db.shop, customers: db.customers, orders: db.orders, staff: db.staff, transactions: [], status_log: [] });
  return reply(404, { error: "not_found", message: "یافت نشد" });
}

let server, base, browser;
const contexts = [];

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/v1/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const { code, obj } = handle(req.method, req.url, raw ? JSON.parse(raw) : {});
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      });
      return;
    }
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
async function waitFor(fn, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error("زمان انتظار تمام شد: " + label);
}

async function openServerApp(dialogs = [], seed = null) {
  freshDb();
  if (seed) seed(db);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  await ctx.addInitScript(() => { window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" }; });
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
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', ADMIN.email);
  await page.fill('#loginForm input[name="password"]', ADMIN.pw);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await sleep(400);
  return { page, errors, unexpected };
}

const bodyText = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || "", sel);
const isHidden = (page, sel) => page.evaluate((s) => document.querySelector(s).hidden, sel);
// بخش‌های حذف‌شده داخل <details> بسته‌اند؛ برای کلیک روی «بازگردانی» باز می‌شوند
const expand = (page, bodySel) => page.evaluate((s) => { const d = document.querySelector(s).closest("details"); if (d) d.open = true; }, bodySel);

test("سرور: حذف مشتری با تأیید؛ سفارش‌هایش بمانند و مشتری از بخش حذف‌شده‌ها برگردد", async () => {
  const { page, errors, unexpected } = await openServerApp([{ ok: true }, { ok: true }]);
  await page.click('.nav-item[data-page="customers"]');
  await waitFor(() => bodyText(page, "#customersBody").then((t) => t.includes("مشتری-یک")), "نمایش مشتری");
  await page.click('#customersBody [data-delete-customer="' + UUID(1) + '"]');
  await waitFor(async () => !(await isHidden(page, "#custDeletedWrap")), "بخش مشتریان حذف‌شده");
  assert.match(await bodyText(page, "#custDeletedBody"), /مشتری-یک/);
  assert.doesNotMatch(await bodyText(page, "#customersBody"), /مشتری-یک/);
  assert.equal(db.orders.filter((o) => !o.deleted_at && o.customer_id === UUID(1)).length, 1, "سفارش مشتری حذف‌شده نماند");

  await expand(page, "#custDeletedBody");
  await page.click('#custDeletedBody [data-restore-customer="' + UUID(1) + '"]');
  await waitFor(async () => (await bodyText(page, "#customersBody")).includes("مشتری-یک"), "بازگشت مشتری");
  assert.equal(await isHidden(page, "#custDeletedWrap"), true);
  assert.equal(db.orders.find((o) => o.id === UUID(5)).deleted_at, null, "بازگردانی مشتری سفارش‌ها را خودکار برنمی‌گرداند");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
});

test("سرور: سفارش مشتری حذف‌شده فقط نمایش داده می‌شود و کنترل تغییر وضعیت و حذف ندارد", async () => {
  const { page, errors } = await openServerApp([], (d) => { d.customers[0].deleted_at = NOW; d.customers[0].version += 1; });
  await page.click('.nav-item[data-page="orders"]');
  await waitFor(async () => (await bodyText(page, "#ordersBody")).includes("مشتری حذف شده"), "برچسب مشتری حذف‌شده");
  const row = await page.evaluate((id) => {
    const cell = [...document.querySelectorAll("#ordersBody tr")].find((tr) => tr.textContent.includes("مشتری-یک"));
    return { hasStatusBtn: !!cell.querySelector("[data-status-index]"), hasDeleteBtn: !!cell.querySelector("[data-delete-order]") };
  });
  assert.deepEqual(row, { hasStatusBtn: false, hasDeleteBtn: false });
  assert.deepEqual(errors, []);
});

test("سرور: حذف سفارش و بازگردانی آن از بخش سفارش‌های حذف‌شده", async () => {
  const { page, errors, unexpected } = await openServerApp([{ ok: true }, { ok: true }]);
  await page.click('.nav-item[data-page="orders"]');
  await waitFor(async () => (await bodyText(page, "#ordersBody")).includes("مشتری-دو"), "نمایش سفارش");
  await page.click('#ordersBody [data-delete-order="' + UUID(6) + '"]');
  await waitFor(async () => !(await isHidden(page, "#orderDeletedWrap")), "بخش سفارش‌های حذف‌شده");
  assert.match(await bodyText(page, "#orderDeletedBody"), /مشتری-دو/);
  assert.equal(db.orders.find((o) => o.id === UUID(6)).deleted_at !== null, true);

  await expand(page, "#orderDeletedBody");
  await page.click('#orderDeletedBody [data-restore-order="' + UUID(6) + '"]');
  await waitFor(async () => (await bodyText(page, "#ordersBody")).includes("مشتری-دو"), "بازگشت سفارش");
  assert.equal(await isHidden(page, "#orderDeletedWrap"), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
});

test("سرور: حذف و بازگردانی همکار", async () => {
  const { page, errors, unexpected } = await openServerApp([{ ok: true }, { ok: true }]);
  await page.click('.nav-item[data-page="coworkers"]');
  await waitFor(async () => (await bodyText(page, "#staffBody")).includes("همکار-یک"), "نمایش همکار");
  await page.click('#staffBody [data-delete-staff="' + UUID(7) + '"]');
  await waitFor(async () => !(await isHidden(page, "#staffDeletedWrap")), "بخش همکاران حذف‌شده");
  assert.doesNotMatch(await bodyText(page, "#staffBody"), /همکار-یک/);

  await expand(page, "#staffDeletedBody");
  await page.click('#staffDeletedBody [data-restore-staff="' + UUID(7) + '"]');
  await waitFor(async () => (await bodyText(page, "#staffBody")).includes("همکار-یک"), "بازگشت همکار");
  assert.equal(await isHidden(page, "#staffDeletedWrap"), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
});
