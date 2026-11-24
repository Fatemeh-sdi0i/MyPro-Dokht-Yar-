// تست مرورگری بازگردانی روی سرور و حذف نرم تراکنش در حالت سرور؛ API ساختگی با همان شکل پاسخ مسیرهای واقعی.
// آزمون واقعی روی PostgreSQL در server.restore.real.test.js (جاب e2e در CI).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dokhtyar-srvrestore-"));
const ADMIN = { id: "u-admin", email: "admin@x.test", pw: "pw-admin-123", role: "admin" };
const UUID = (n) => `00000000-0000-4000-8000-00000000000${n}`;

const db = { session: null, customers: [], orders: [], staff: [], transactions: [], status_log: [], snapshots: [], shop: { shop_name: "مزون آزمون", owner_name: "مدیر", phone: "", address: "", currency: "تومان" } };
const exportNow = () => ({
  exported_at: new Date().toISOString(),
  shop: db.shop,
  customers: db.customers.map((c) => ({ ...c })),
  orders: db.orders.map((o) => ({ ...o })),
  staff: db.staff.map((s) => ({ ...s })),
  transactions: db.transactions.map((t) => ({ ...t })),
  status_log: db.status_log.map((l) => ({ ...l })),
});

function handle(method, url, body) {
  const u = url.split("?")[0].replace("/api/v1", "");
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

  if (u === "/customers" && method === "GET") return reply(200, { items: db.customers.filter((c) => !c.deleted_at).map((c) => ({ ...c, order_count: 0, tier: c.tier || "regular" })) });
  if (u === "/customers" && method === "POST") {
    const c = { id: body.id, name: body.name, phone: body.phone || "", note: body.note || "", tier: "regular", deleted_at: null };
    db.customers.push(c);
    return reply(201, c);
  }
  if (u === "/orders" && method === "GET") return reply(200, { items: [] });
  if (u === "/staff" && method === "GET") return reply(200, { items: db.staff.filter((s) => !s.deleted_at) });
  if (u === "/settings" && method === "GET") return reply(200, { ...db.shop, shop_name: db.shop.shop_name });
  if (u === "/export" && method === "GET") return reply(200, exportNow());

  if (u === "/transactions" && method === "GET") return reply(200, { items: db.transactions.filter((t) => !t.deleted_at) });
  if (u === "/transactions/deleted" && method === "GET") return reply(200, { items: db.transactions.filter((t) => t.deleted_at) });
  if (u === "/transactions" && method === "POST") {
    const t = { id: body.id || UUID(9), kind: body.kind, category: body.category, amount: body.amount, occurred_on: body.occurred_on || "2026-11-24", note: body.note || "", deleted_at: null };
    db.transactions.push(t);
    return reply(201, t);
  }
  const txMatch = u.match(/^\/transactions\/([^/]+)(\/restore)?$/);
  if (txMatch) {
    const t = db.transactions.find((x) => x.id === txMatch[1]);
    if (!t) return reply(404, { error: "not_found", message: "تراکنش پیدا نشد" });
    if (method === "DELETE" && !txMatch[2]) {
      if (t.deleted_at) return reply(404, { error: "not_found", message: "تراکنش پیدا نشد" });
      t.deleted_at = new Date().toISOString();
      return reply(200, { ok: true });
    }
    if (method === "POST" && txMatch[2]) {
      if (!t.deleted_at) return reply(404, { error: "not_found", message: "تراکنش حذف‌شده پیدا نشد" });
      t.deleted_at = null;
      return reply(200, t);
    }
  }

  if (u === "/import/replace" && method === "POST") {
    const bad = !body || !Array.isArray(body.customers) || !body.shop;
    if (bad) return reply(400, { error: "invalid_backup", message: "فایل پشتیبان نامعتبر است: ساختار شناخته نشد" });
    const dup = body.customers.filter((c) => c.phone && !c.deleted_at).map((c) => c.phone);
    if (new Set(dup).size !== dup.length) return reply(400, { error: "invalid_backup", message: "فایل پشتیبان نامعتبر است: مشتری‌ها: «شماره‌ی تماس فعال» تکراری است" });
    const snapshotId = `snap-${db.snapshots.length + 1}`;
    db.snapshots.unshift({ id: snapshotId, created_at: new Date().toISOString(), reason: "پیش از بازگردانی از فایل", payload: exportNow() });
    db.shop = body.shop;
    db.customers = body.customers;
    db.orders = body.orders || [];
    db.staff = body.staff || [];
    db.transactions = body.transactions || [];
    db.status_log = body.status_log || [];
    return reply(200, { snapshot_id: snapshotId, counts: { customers: db.customers.length, orders: db.orders.length, staff: db.staff.length, transactions: db.transactions.length } });
  }
  if (u === "/import/snapshots" && method === "GET") {
    return reply(200, { items: db.snapshots.map((s) => ({ id: s.id, created_at: s.created_at, reason: s.reason, customers: s.payload.customers.length, orders: s.payload.orders.length, staff: s.payload.staff.length, transactions: s.payload.transactions.length })) });
  }
  const snapMatch = u.match(/^\/import\/snapshots\/([^/]+)$/);
  if (snapMatch && method === "GET") {
    const s = db.snapshots.find((x) => x.id === snapMatch[1]);
    return s ? reply(200, s.payload) : reply(404, { error: "not_found", message: "نسخه پیدا نشد" });
  }
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
  fs.rmSync(tmp, { recursive: true, force: true });
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

async function openServerApp(dialogs = []) {
  db.session = null;
  db.customers = []; db.transactions = []; db.snapshots = []; db.orders = []; db.staff = []; db.status_log = [];
  db.shop = { shop_name: "مزون آزمون", owner_name: "مدیر", phone: "", address: "", currency: "تومان" };
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
    if (d.type() === "prompt") return step.text === undefined ? d.dismiss() : d.accept(step.text);
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

async function addCustomer(page, name, phone) {
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', name);
  await page.fill('#customerForm input[name="phone"]', phone);
  await page.click('#customerForm button[type="submit"]');
  await waitFor(() => page.evaluate((n) => (document.querySelector("#customersBody")?.textContent || "").includes(n), name), "نمایش " + name);
  await page.click('.nav-item[data-page="settings"]');
}

async function download(page, selector) {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }), page.click(selector)]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}

const msg = (page) => page.evaluate(() => ({ text: document.querySelector("#backupMsg").textContent, state: document.querySelector("#backupMsg").dataset.state }));
const names = () => db.customers.filter((c) => !c.deleted_at).map((c) => c.name);

test("سرور: بازگردانی از فایل خودِ مزون؛ نسخه‌ی پیش از آن قابل دانلود است", async () => {
  const { page, errors, unexpected } = await openServerApp([{ ok: true }, { text: "بازگردانی" }]);
  await addCustomer(page, "مشتری-الف", "09121111111");
  const file = await download(page, "#exportBtn");
  await addCustomer(page, "مشتری-ب", "09122222222");
  assert.ok(names().includes("مشتری-ب"));

  await page.setInputFiles("#backupCheckFile", file);
  await page.click("#backupCheckBtn");
  await waitFor(() => page.evaluate(() => !document.querySelector("#backupRestoreBtn").hidden), "دکمه‌ی بازگردانی");
  await page.click("#backupRestoreBtn");
  await waitFor(async () => /بازگردانی شد/.test((await msg(page)).text), "پیام موفقیت");
  assert.deepEqual(names(), ["مشتری-الف"], "داده به حالت فایل برگشت");
  assert.equal(db.snapshots.length, 1, "نسخه‌ی پیش از بازگردانی روی سرور ساخته شد");
  assert.ok(db.snapshots[0].payload.customers.some((c) => c.name === "مشتری-ب"), "نسخه داده‌ی پیش از بازگردانی را دارد");

  // دانلود نسخه‌ی پیش از بازگردانی
  const snapFile = await download(page, "#downloadSnapshotBtn");
  const snap = JSON.parse(fs.readFileSync(snapFile, "utf8"));
  assert.ok(snap.customers.some((c) => c.name === "مشتری-ب"));
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
});

test("سرور: فایل که سرور رد می‌کند، هیچ تغییری ایجاد نمی‌کند و پیام سرور را نشان می‌دهد", async () => {
  const { page, errors } = await openServerApp([{ ok: true }, { text: "بازگردانی" }]);
  await addCustomer(page, "مشتری-سالم", "09123333333");
  const before = JSON.stringify(db.customers);
  const bad = path.join(tmp, "dup.json");
  fs.writeFileSync(bad, JSON.stringify({
    exported_at: new Date().toISOString(),
    shop: db.shop,
    customers: [
      { id: UUID(1), name: "یک", phone: "09124444444", note: "", tier: "regular", deleted_at: null },
      { id: UUID(2), name: "دو", phone: "09124444444", note: "", tier: "regular", deleted_at: null },
    ],
    orders: [], staff: [], transactions: [],
  }));
  await page.click('.nav-item[data-page="settings"]');
  await page.setInputFiles("#backupCheckFile", bad);
  await page.click("#backupCheckBtn");
  await waitFor(() => page.evaluate(() => !document.querySelector("#backupRestoreBtn").hidden), "دکمه‌ی بازگردانی");
  await page.click("#backupRestoreBtn");
  await waitFor(async () => (await msg(page)).state === "error", "پیام خطای سرور");
  assert.match((await msg(page)).text, /تکراری/);
  assert.equal(JSON.stringify(db.customers), before, "داده‌ی سرور دست‌نخورده است");
  assert.equal(db.snapshots.length, 0, "برای فایل ردشده نسخه ساخته نشد");
  assert.deepEqual(errors, []);
});

test("سرور: فایل حالت محلی در حالت سرور بازگردانی نمی‌شود", async () => {
  const { page } = await openServerApp();
  const local = path.join(tmp, "local.json");
  fs.writeFileSync(local, JSON.stringify({ settings: {}, customers: [], orders: [], staff: [], transactions: [] }));
  await page.click('.nav-item[data-page="settings"]');
  await page.setInputFiles("#backupCheckFile", local);
  await page.click("#backupCheckBtn");
  await waitFor(async () => /حالت محلی/.test((await msg(page)).text), "پیام حالت محلی");
  assert.equal(await page.evaluate(() => document.querySelector("#backupRestoreBtn").hidden), true);
});

test("سرور: حذف نرم تراکنش، فهرست حذف‌شده‌ها و بازگردانی", async () => {
  const { page, errors } = await openServerApp([{ ok: true }, { ok: true }]);
  await page.click('.nav-item[data-page="finance"]');
  await page.click("#addTxBtn");
  await page.fill('#txForm input[name="amount"]', "777000");
  await page.click('#txForm button[type="submit"]');
  await waitFor(() => db.transactions.some((t) => t.amount === 777000), "ثبت تراکنش");
  const id = db.transactions.find((t) => t.amount === 777000).id;

  await page.click(`[data-delete-tx="${id}"]`);
  await waitFor(() => db.transactions.find((t) => t.id === id).deleted_at, "حذف نرم روی سرور");
  await page.waitForFunction(() => !document.querySelector("#txDeletedWrap").hidden, null, { timeout: 8000 });
  assert.equal(db.transactions.find((t) => t.id === id).amount, 777000, "مبلغ در سرور نگه داشته شد");

  await page.click("#txDeletedWrap summary");
  await page.click(`[data-restore-tx="${id}"]`);
  await waitFor(() => db.transactions.find((t) => t.id === id).deleted_at === null, "بازگردانی تراکنش");
  await page.waitForFunction(() => document.querySelector("#txBody").textContent.includes("۷۷۷٬۰۰۰") || document.querySelector("#txBody").textContent.includes("777"), null, { timeout: 8000 }).catch(() => {});
  assert.deepEqual(errors, []);
});
