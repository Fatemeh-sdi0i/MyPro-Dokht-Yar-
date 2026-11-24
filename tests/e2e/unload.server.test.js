// هشدار خروج حالت سرور: وقتی IndexedDB نیست و تغییر در صف مانده، مرورگر باید پیش از بستن صفحه تأیید بگیرد.
// API ساختگی (بدون PostgreSQL) و مرورگر واقعی؛ همان الگوی offline.mock.test.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

const shopSettings = (name) => ({ shop_name: name, owner_name: "مدیر", phone: "", address: "", currency: "تومان" });
const state = {
  shop: { customers: [], orders: [], staff: [], transactions: [], settings: shopSettings("مزون الف") },
  user: { id: "user-a", shop: "A", pw: "pw-a-123", role: "admin", email: "a@x.test" },
  session: null,
};

// فقط مسیرهایی که این آزمون به آن‌ها نیاز دارد
function handle(method, url, body) {
  const u = url.split("?")[0].replace("/api/v1", "");
  const reply = (code, obj) => ({ code, obj });
  if (method === "POST" && u === "/auth/login") {
    if (body.email !== state.user.email || body.password !== state.user.pw) {
      return reply(401, { error: "invalid_credentials", message: "ایمیل یا گذرواژه درست نیست" });
    }
    state.session = state.user;
    return reply(200, { user: { id: state.user.id, role: state.user.role } });
  }
  if (method === "POST" && u === "/auth/logout") { state.session = null; return reply(200, { ok: true }); }
  if (method === "GET" && u === "/auth/me") {
    return state.session ? reply(200, { user: { id: state.session.id, role: state.session.role } })
      : reply(401, { error: "unauthorized", message: "ورود لازم است" });
  }
  if (!state.session) return reply(401, { error: "unauthorized", message: "ورود لازم است" });
  if (u === "/customers" && method === "GET") return reply(200, { items: state.shop.customers });
  if (u === "/customers" && method === "POST") {
    const same = state.shop.customers.find((c) => c.id === body.id);
    if (same) return reply(200, same);
    const c = { id: body.id, name: body.name, phone: body.phone || "", note: body.note || "", tier: "regular", order_count: 0 };
    state.shop.customers.push(c);
    return reply(201, c);
  }
  if (u === "/orders" && method === "GET") return reply(200, { items: state.shop.orders });
  if (u === "/staff" && method === "GET") return reply(200, { items: state.shop.staff });
  if (u === "/transactions" && method === "GET") return reply(200, { items: state.shop.transactions });
  if (u === "/settings" && method === "GET") return reply(200, state.shop.settings);
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

// noIndexedDb: مرورگری که IndexedDB ندارد (مثلاً حالت خصوصی قدیمی)
async function openServerApp({ noIndexedDb }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  await ctx.addInitScript(() => { window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" }; });
  if (noIndexedDb) {
    await ctx.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", { get: () => undefined, configurable: true });
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/index.html");
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', state.user.email);
  await page.fill('#loginForm input[name="password"]', state.user.pw);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await sleep(400);
  return { ctx, page, errors };
}

async function addCustomer(page, name) {
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', name);
  await page.fill('#customerForm input[name="phone"]', "09121234567");
  await page.click('#customerForm button[type="submit"]');
  await sleep(300);
}

// رویداد beforeunload را همگام می‌فرستد و می‌گوید مرورگر تأیید می‌خواهد یا نه
const unloadPrevented = (page) => page.evaluate(() => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});
const unsent = (page) => page.evaluate(() => Sync.unsentSessionCount());
const pending = (page) => page.evaluate(() => Sync.pendingCount());

test("بدون IndexedDB: تغییر در صف مانده، خروج را با هشدار مرورگر همراه می‌کند", async (t) => {
  state.shop.customers = [];
  state.session = null;
  await t.test("تغییر آفلاین: هشدار خروج فعال است، و پس از اتصال و ارسال برداشته می‌شود", async () => {
    const { ctx, page, errors } = await openServerApp({ noIndexedDb: true });
    await ctx.setOffline(true);
    await addCustomer(page, "مشتری آفلاین بی‌آی‌دی‌بی");
    assert.equal(await pending(page), 1, "تغییر باید در صف بماند");
    assert.equal(await unsent(page), 1, "شمارش همگام تغییرهای فقط‌حافظه");
    assert.equal(await unloadPrevented(page), true, "تغییر در صف: مرورگر باید تأیید بگیرد");

    await ctx.setOffline(false);
    await page.evaluate(() => Sync.flush());
    await waitFor(async () => state.shop.customers.some((c) => c.name === "مشتری آفلاین بی‌آی‌دی‌بی"), "ارسال صف به سرور");
    await waitFor(async () => (await unsent(page)) === 0, "خالی شدن شمارش فقط‌حافظه");
    assert.equal(await unloadPrevented(page), false, "صف خالی: هشداری نباید بماند");
    assert.deepEqual(errors, [], "خطای صفحه نباید رخ دهد");
  });
});

test("با IndexedDB: صف پایدار است و هشدار لازم نیست", async (t) => {
  state.shop.customers = [];
  state.session = null;
  await t.test("تغییر آفلاین در IndexedDB: شمارش فقط‌حافظه صفر است", async () => {
    const { ctx, page } = await openServerApp({ noIndexedDb: false });
    await ctx.setOffline(true);
    await addCustomer(page, "مشتری آفلاین با آی‌دی‌بی");
    assert.equal(await pending(page), 1, "تغییر در صف پایدار است");
    assert.equal(await unsent(page), 0, "شمارش فقط‌حافظه نباید بشمارد");
    assert.equal(await unloadPrevented(page), false, "صف پایدار: هشدار لازم نیست");
  });
});

test("بدون IndexedDB اما آنلاین: تغییر فوری ارسال می‌شود و هشداری نمی‌ماند", async (t) => {
  state.shop.customers = [];
  state.session = null;
  await t.test("ارسال موفق: خروج بی‌هشدار است", async () => {
    const { page } = await openServerApp({ noIndexedDb: true });
    await addCustomer(page, "مشتری آنلاین");
    await waitFor(async () => state.shop.customers.some((c) => c.name === "مشتری آنلاین"), "ارسال به سرور");
    assert.equal(await unsent(page), 0, "ارسال‌شده در صف نیست");
    assert.equal(await unloadPrevented(page), false, "بدون صف: هشدار نباید باشد");
  });
});
