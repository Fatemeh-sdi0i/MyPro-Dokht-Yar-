// تست مرورگری صف آفلاین با API ساختگی دو مزونه (بدون PostgreSQL).
// بررسی می‌کند: جداسازی مزون‌ها، خروج و ورود دوباره، خطای موقت ۵۰۳، ردشدن و بازیابی تغییرات.
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
  shops: { A: { customers: [], orders: [], staff: [], transactions: [], settings: shopSettings("مزون الف") },
           B: { customers: [], orders: [], staff: [], transactions: [], settings: shopSettings("مزون ب") } },
  users: { "a@x.test": { id: "user-a", shop: "A", pw: "pw-a-123", role: "admin" },
           "b@x.test": { id: "user-b", shop: "B", pw: "pw-b-456", role: "admin" } },
  session: null,
  faults: [], // {method, path, status}: هر خطا یک بار اجرا می‌شود
  requests: [],
};

function handle(method, url, body) {
  const u = url.split("?")[0].replace("/api/v1", "");
  const reply = (code, obj) => ({ code, obj });
  state.requests.push(method + " " + u);
  if (method === "POST" && u === "/auth/login") {
    const x = state.users[body.email];
    if (!x || x.pw !== body.password) return reply(401, { error: "invalid_credentials", message: "ایمیل یا گذرواژه درست نیست" });
    state.session = x;
    return reply(200, { user: { id: x.id, role: x.role } });
  }
  if (method === "POST" && u === "/auth/logout") { state.session = null; return reply(200, { ok: true }); }
  if (method === "GET" && u === "/auth/me") {
    return state.session ? reply(200, { user: { id: state.session.id, role: state.session.role } })
      : reply(401, { error: "unauthorized", message: "ورود لازم است" });
  }
  if (!state.session) return reply(401, { error: "unauthorized", message: "ورود لازم است" });
  const db = state.shops[state.session.shop];
  const fi = state.faults.findIndex((f) => f.method === method && u.startsWith(f.path));
  if (fi >= 0) {
    const f = state.faults.splice(fi, 1)[0];
    return reply(f.status, { error: "server_error", message: "خطای موقت سرور" });
  }
  if (u === "/customers" && method === "GET") return reply(200, { items: db.customers });
  if (u === "/customers" && method === "POST") {
    if (body.name === "BAD") return reply(400, { error: "invalid_phone", message: "داده‌ی نامعتبر" });
    const same = db.customers.find((c) => c.id === body.id);
    if (same) return reply(200, same); // تکرار ارسال: همان ردیف
    const c = { id: body.id, name: body.name, phone: body.phone || "", note: body.note || "", tier: "regular", order_count: 0 };
    db.customers.push(c);
    return reply(201, c);
  }
  if (u === "/orders" && method === "GET") return reply(200, { items: db.orders });
  if (u === "/staff" && method === "GET") return reply(200, { items: db.staff });
  if (u === "/transactions" && method === "GET") return reply(200, { items: db.transactions });
  if (u === "/settings" && method === "GET") return reply(200, db.settings);
  return reply(404, { error: "not_found", message: "یافت نشد" });
}

let server, base, browser, ctx, page;
const pageErrors = [];

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
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  await ctx.addInitScript(() => { window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" }; });
  page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/index.html");
  await page.waitForSelector("#loginGate:not([hidden])");
});

after(async () => {
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
const pending = () => page.evaluate(() => Sync.pendingCount());
const rawQueueCount = () => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open("dokhtyar-sync");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const req = db.transaction("queue", "readonly").objectStore("queue").count();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  };
}));
const rawCount = (store) => page.evaluate((store) => new Promise((resolve, reject) => {
  const open = indexedDB.open("dokhtyar-sync");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const req = db.transaction(store, "readonly").objectStore(store).count();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  };
}), store);
const rawHas = (store, key) => page.evaluate(([store, key]) => new Promise((resolve, reject) => {
  const open = indexedDB.open("dokhtyar-sync");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result !== undefined); };
    req.onerror = () => reject(req.error);
  };
}), [store, key]);
const rejectedCount = () => page.evaluate(async () => (await Sync.rejectedOps()).length);

async function login(email, pw) {
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', email);
  await page.fill('#loginForm input[name="password"]', pw);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
}
async function logoutViaUi() {
  await page.click('.nav-item[data-page="settings"]');
  await page.click("#logoutBtn");
  await page.waitForSelector("#loginGate:not([hidden])");
}
async function addCustomer(name) {
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', name);
  await page.fill('#customerForm input[name="phone"]', "09121234567");
  await page.click('#customerForm button[type="submit"]');
  await sleep(300);
}
const names = (shop) => state.shops[shop].customers.map((c) => c.name);

test("جداسازی، خروج آفلاین و همگام‌سازی بین مزون‌ها", async (t) => {
  await t.test("ثبت آفلاین در مزون الف و نبود آن روی سرور", async () => {
    await login("a@x.test", "pw-a-123");
    await sleep(400);
    await ctx.setOffline(true);
    await addCustomer("مشتری آفلاین الف");
    assert.equal(await pending(), 1);
    assert.deepEqual(names("A"), []);
  });

  await t.test("خروج آفلاین: صف و ثبت خروج می‌مانند، کش نمایشی پاک می‌شود، و گیت ورود نشان داده می‌شود", async () => {
    await logoutViaUi();
    assert.equal(await rawCount("queue"), 2, "تغییر + خروج باید در صف بمانند");
    assert.equal(await rawHas("cache", "snapshot:user-a"), false, "کش نمایشی باید پاک شود");
    await page.reload();
    await page.waitForSelector("#loginGate:not([hidden])");
    assert.notEqual(state.session, null, "سرور هنوز نشست را دارد؛ خروج هنوز ارسال نشده");
    assert.deepEqual(names("A"), [], "بدون اینترنت داده‌ی مزون نشان داده نمی‌شود");
  });

  await t.test("اتصال بعدی: بوت صف و خروج را کامل می‌کند، نشست سرور باطل می‌شود", async () => {
    await ctx.setOffline(false);
    await page.reload();
    await waitFor(async () => state.session === null && (await rawCount("queue")) === 0, "تکمیل خروج آفلاین");
    assert.deepEqual(names("A"), ["مشتری آفلاین الف"], "تغییر آفلاین یک‌بار ثبت شده");
    assert.equal(await rawHas("cache", "logout:user-a"), false);
    await page.waitForSelector("#loginGate:not([hidden])");
  });

  await t.test("ورود مزون ب: داده‌ی مزون الف دیده نمی‌شود", async () => {
    await login("b@x.test", "pw-b-456");
    await sleep(800);
    assert.equal(await pending(), 0);
    assert.deepEqual(names("B"), []);
    await page.click('.nav-item[data-page="customers"]');
    assert.equal((await page.textContent("body")).includes("مشتری آفلاین الف"), false);
    await logoutViaUi();
  });

  await t.test("ورود دوباره‌ی مزون الف: هیچ تکراری ساخته نمی‌شود", async () => {
    await login("a@x.test", "pw-a-123");
    await waitFor(async () => (await pending()) === 0, "پایان همگام‌سازی بعد از ورود");
    assert.deepEqual(names("A"), ["مشتری آفلاین الف"]);
    assert.deepEqual(names("B"), []);
  });
});

test("خطای موقت سرور تغییر را حذف نمی‌کند", async (t) => {
  await t.test("۵۰۳ یک‌باره: تغییر در صف می‌ماند و بار دوم ثبت می‌شود", async () => {
    await ctx.setOffline(true);
    await addCustomer("مشتری موقت");
    assert.equal(await pending(), 1);
    await ctx.setOffline(false);
    state.faults.push({ method: "POST", path: "/customers", status: 503 });
    await page.evaluate(() => syncNow());
    await sleep(300);
    assert.equal(await pending(), 1, "با ۵۰۳ تغییر نباید حذف شود");
    assert.equal(await rejectedCount(), 0, "با ۵۰۳ تغییر نباید ردشده باشد");
    assert.equal(names("A").includes("مشتری موقت"), false);
    await page.evaluate(() => syncNow());
    await waitFor(async () => (await pending()) === 0, "ارسال بعد از خطای موقت");
    assert.equal(names("A").filter((n) => n === "مشتری موقت").length, 1);
  });
});

test("تغییر پذیرفته‌نشده در فهرست دیده می‌شود و قابل بازیابی یا حذف است", async (t) => {
  await t.test("۴۰۰ دائمی: به فهرست ردشده می‌رود و در تنظیمات دیده می‌شود", async () => {
    await ctx.setOffline(true);
    await addCustomer("BAD");
    await ctx.setOffline(false);
    await page.evaluate(() => syncNow());
    await waitFor(async () => (await rejectedCount()) === 1, "ثبت در فهرست ردشده");
    assert.equal(await pending(), 0);
    await page.click('.nav-item[data-page="settings"]');
    await page.waitForSelector("#rejectedBox:not([hidden])");
    const text = await page.textContent("#rejectedList");
    assert.ok(text.includes("مشتری"), "عنوان تغییر دیده شود");
    assert.ok(text.includes("داده‌ی نامعتبر"), "دلیل رد دیده شود");
  });

  await t.test("حذف با تأیید: تغییر از فهرست و از دستگاه پاک می‌شود", async () => {
    await page.click('#rejectedList button[data-action="discard"]');
    await waitFor(async () => (await rejectedCount()) === 0, "حذف از فهرست ردشده");
    assert.equal(await pending(), 0);
    await page.waitForSelector("#rejectedBox[hidden]", { state: "attached" });
  });
});

test("صفحه بدون خطای برنامه کار کرده است", async () => {
  assert.deepEqual(pageErrors, []);
});
