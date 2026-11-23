// تست مرورگری رمزنگاری داده‌ی همگام‌نشده در IndexedDB (کلید غیرقابل استخراج، مهاجرت، از دست رفتن کلید).
// IndexedDB و WebCrypto واقعی مرورگرند؛ API ساختگی کوچکی برای ورود و ثبت مشتری استفاده می‌شود.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const SECRET_NAME = "نام-رمزی-آزمون";

const state = { session: null, customers: [], posts: [] };
const user = { id: "user-enc", email: "enc@x.test", pw: "pw-enc-789", role: "admin" };

function handle(method, url, body) {
  const u = url.split("?")[0].replace("/api/v1", "");
  const reply = (code, obj) => ({ code, obj });
  if (method === "POST" && u === "/auth/login") {
    if (body.email !== user.email || body.password !== user.pw) return reply(401, { error: "invalid_credentials", message: "ایمیل یا گذرواژه درست نیست" });
    state.session = user;
    return reply(200, { user: { id: user.id, role: user.role } });
  }
  if (method === "POST" && u === "/auth/logout") { state.session = null; return reply(200, { ok: true }); }
  if (method === "GET" && u === "/auth/me") {
    return state.session ? reply(200, { user: { id: user.id, role: user.role } }) : reply(401, { error: "unauthorized", message: "ورود لازم است" });
  }
  if (!state.session) return reply(401, { error: "unauthorized", message: "ورود لازم است" });
  if (u === "/customers" && method === "GET") return reply(200, { items: state.customers });
  if (u === "/customers" && method === "POST") {
    state.posts.push(body.name);
    const c = { id: body.id, name: body.name, phone: body.phone || "", note: body.note || "", tier: "regular", order_count: 0 };
    state.customers.push(c);
    return reply(201, c);
  }
  if (u === "/orders" && method === "GET") return reply(200, { items: [] });
  if (u === "/staff" && method === "GET") return reply(200, { items: [] });
  if (u === "/transactions" && method === "GET") return reply(200, { items: [] });
  if (u === "/settings" && method === "GET") return reply(200, { shop_name: "مزون رمز", owner_name: "مدیر", phone: "", address: "", currency: "تومان" });
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

// دسترسی خام به IndexedDB برگه (برای بررسی آنچه واقعاً ذخیره شده)
const rawIdb = (fnBody, arg) => page.evaluate(([body, a]) => new Promise((resolve, reject) => {
  const open = indexedDB.open("dokhtyar-sync");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const fn = new Function("db", "arg", "resolve", "reject", body);
    fn(db, a, (v) => { db.close(); resolve(v); }, (e) => { db.close(); reject(e); });
  };
}), [fnBody, arg]);

const rawRecords = (store) => rawIdb(`
  const req = db.transaction(arg, "readonly").objectStore(arg).getAll();
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);`, store);

const rawDeviceKey = () => rawIdb(`
  const req = db.transaction("keys", "readonly").objectStore("keys").get("device");
  req.onsuccess = () => resolve(req.result ? { exists: true, extractable: req.result.key.extractable, usages: [...req.result.key.usages] } : { exists: false });
  req.onerror = () => reject(req.error);`);

const rawPutRecord = (store, rec) => rawIdb(`
  const tx = db.transaction(arg.store, "readwrite");
  tx.objectStore(arg.store).put(arg.rec);
  tx.oncomplete = () => resolve(true);
  tx.onerror = () => reject(tx.error);`, { store, rec });

const rawDeleteKey = () => rawIdb(`
  const tx = db.transaction("keys", "readwrite");
  tx.objectStore("keys").delete("device");
  tx.oncomplete = () => resolve(true);
  tx.onerror = () => reject(tx.error);`);

const pending = () => page.evaluate(() => Sync.pendingCount());

async function login() {
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', user.email);
  await page.fill('#loginForm input[name="password"]', user.pw);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await sleep(300);
}

async function addCustomer(name) {
  await page.click('.nav-item[data-page="customers"]');
  await page.click("#addCustomerBtn");
  await page.fill('#customerForm input[name="name"]', name);
  await page.fill('#customerForm input[name="phone"]', "09120000000");
  await page.click('#customerForm button[type="submit"]');
  await sleep(300);
}

test("رمزنگاری: صف آفلاین در IndexedDB متن ساده ندارد و بعد از بارگذاری آفلاین خوانده می‌شود", async (t) => {
  await t.test("ورود و ثبت آفلاین مشتری", async () => {
    await login();
    await sleep(400);
    await ctx.setOffline(true);
    await addCustomer(SECRET_NAME);
    assert.equal(await pending(), 1);
  });

  await t.test("رکورد خام صف رمزشده است و کلید غیرقابل استخراج است", async () => {
    const recs = await rawRecords("queue");
    const dump = JSON.stringify(recs);
    assert.equal(dump.includes(SECRET_NAME), false, "نام مشتری نباید در ذخیره‌ی خام باشد");
    assert.equal(dump.includes("09120000000"), false, "شماره‌ی تماس نباید در ذخیره‌ی خام باشد");
    assert.ok(recs.every((r) => r.sealed), "همه‌ی رکوردهای صف رمزشده‌اند");
    const key = await rawDeviceKey();
    assert.equal(key.exists, true);
    assert.equal(key.extractable, false, "کلید نباید قابل استخراج باشد");
    assert.deepEqual(key.usages.sort(), ["decrypt", "encrypt"]);
  });

  await t.test("بارگذاری مجدد آفلاین: صف و نام مشتری از رمز بازشده خوانده می‌شوند", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#loginGate:not([hidden]), .nav-item", { timeout: 10000 });
    await sleep(500);
    assert.equal(await pending(), 1, "تغییر صف با بارگذاری مجدد از بین نرفته");
    const [op] = await page.evaluate(() => Sync.pendingOps());
    assert.equal(op.body.name, SECRET_NAME);
  });

  await t.test("اتصال: تغییر یک‌بار روی سرور ثبت و صف خالی می‌شود", async () => {
    await ctx.setOffline(false);
    await page.evaluate(() => syncNow());
    await waitFor(async () => (await pending()) === 0, "ارسال صف رمزشده");
    await waitFor(async () => (await rawRecords("queue")).length === 0, "حذف رکورد ارسال‌شده");
  });
});

test("مهاجرت: رکورد ساده‌ی قدیمی در بوت رمز می‌شود و بعد همگام می‌شود", async (t) => {
  const legacyName = "مشتری-قدیمی-ساده";
  await t.test("درج رکورد ساده‌ی قدیمی (آفلاین، تا زبانه‌ی باز همگام نکند) و بارگذاری آفلاین", async () => {
    await ctx.setOffline(true);
    await sleep(300);
    await rawPutRecord("queue", {
      opId: "legacy-op-1", scope: user.id, method: "POST", path: "/customers",
      body: { id: "legacy-cust-1", name: legacyName, phone: "09001112222" },
      meta: { title: "مشتری: " + legacyName, detail: "" }, createdAt: Date.now(), order: 1,
    });
    assert.ok(JSON.stringify(await rawRecords("queue")).includes(legacyName), "پیش از مهاجرت ساده است");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitFor(async () => (await pending()) === 1, "بوت آفلاین و شمارش صف");
  });

  await t.test("بعد از بوت: متن ساده نمانده، عملیات حفظ شده و هنوز ارسال نشده", async () => {
    const dump = JSON.stringify(await rawRecords("queue"));
    assert.equal(dump.includes(legacyName), false, "بعد از بوت متن ساده نباید بماند");
    assert.equal(state.posts.includes(legacyName), false, "هنوز ارسال نشده");
    const [op] = await page.evaluate(() => Sync.pendingOps());
    assert.equal(op.body.name, legacyName, "مهاجرت داده را خراب نکرده");
  });

  await t.test("اتصال: عملیات قدیمی با داده‌ی درست ارسال می‌شود", async () => {
    await ctx.setOffline(false);
    await waitFor(async () => state.posts.includes(legacyName), "ارسال عملیات مهاجرت‌شده", 10000);
    await waitFor(async () => (await pending()) === 0, "پاک شدن صف");
  });
});

test("از دست رفتن کلید: داده حذف نمی‌شود، کلید تازه ساخته نمی‌شود و ارسال متوقف می‌ماند", async (t) => {
  await t.test("ثبت آفلاین و سپس حذف کلید (زبانه‌ی باز هنوز کلید را در حافظه دارد)", async () => {
    await ctx.setOffline(true);
    await addCustomer("مشتری-قفل-شده");
    assert.equal(await pending(), 1);
    await rawDeleteKey();
    assert.equal((await rawDeviceKey()).exists, false);
  });

  await t.test("بارگذاری تازه‌ی آفلاین: کلید تازه ساخته نمی‌شود و رکورد حذف نمی‌شود", async () => {
    // زبانه‌ی تازه کلید ندارد؛ بدون کلید نشانه‌ی آخرین کاربر هم خوانده نمی‌شود و گیت ورود نشان داده می‌شود
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#loginGate:not([hidden])", { timeout: 10000 });
    assert.equal((await rawDeviceKey()).exists, false, "کلید تازه نباید ساخته شود");
    assert.equal((await rawRecords("queue")).length, 1, "رکورد حذف نشده");
  });

  await t.test("ورود آنلاین: ارسال نمی‌شود و پیام قفل نمایش داده می‌شود", async () => {
    const before = state.posts.length;
    await ctx.setOffline(false);
    await login();
    await waitFor(async () => (await page.evaluate(() => Sync.localDataStatus())).unreadable === 1, "شمارش ناخوانا");
    assert.equal(state.posts.length, before, "هیچ ارسالی نباید انجام شود");
    assert.equal((await rawRecords("queue")).length, 1, "رکورد همچنان هست");
    assert.equal((await rawDeviceKey()).exists, false, "کلید تازه نباید ساخته شود");
    await page.click('.nav-item[data-page="settings"]');
    await page.waitForSelector("#syncLocked:not([hidden])", { timeout: 5000 });
    const text = await page.textContent("#syncLocked");
    assert.ok(text.includes("قابل خواندن نیستند"), "پیام قفل دیده شود");
  });
});

test("هیچ خطای صفحه‌ای ثبت نشده است", () => {
  assert.deepEqual(pageErrors, []);
});
