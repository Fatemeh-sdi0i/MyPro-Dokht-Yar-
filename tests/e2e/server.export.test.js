// تست مرورگری پشتیبان در حالت سرور: GET /export برای مدیر، رمزنگاری و رد شدن برای غیرمدیر.
// API ساختگی با همان شکل پاسخ مسیر واقعی /export (backend/src/routes/business.js)؛
// نسخه‌ی واقعی روی PostgreSQL در جاب e2e CI با E2E_BASE اجرا می‌شود (server.export.real.test.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const PASS = "گذرواژه-سرور-۱۲۳";
const CUSTOMER = "مشتری-سرور-اکسپورت";
const PHONE = "09121234567";

const state = {
  user: { id: "user-admin", email: "admin@x.test", pw: "pw-admin-123", role: "admin" },
  session: null,
  customers: [],
};

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
  if (u === "/customers" && method === "GET") return reply(200, { items: state.customers });
  if (u === "/customers" && method === "POST") {
    const c = { id: body.id, name: body.name, phone: body.phone || "", note: body.note || "", tier: "regular", order_count: 0 };
    state.customers.push(c);
    return reply(201, c);
  }
  if (u === "/orders" && method === "GET") return reply(200, { items: [] });
  if (u === "/staff" && method === "GET") return reply(200, { items: [] });
  if (u === "/transactions" && method === "GET") return reply(200, { items: [] });
  if (u === "/settings" && method === "GET") {
    return reply(200, { shop_name: "مزون آزمون", owner_name: "مدیر", phone: "", address: "", currency: "تومان" });
  }
  if (method === "GET" && u === "/export") {
    // شکل واقعی: exported_at, shop, و فهرست‌ها
    if (state.session.role !== "admin") return reply(403, { error: "forbidden", message: "فقط مدیر می‌تواند پشتیبان بگیرد" });
    return reply(200, {
      exported_at: new Date().toISOString(),
      shop: { shop_name: "مزون آزمون", owner_name: "مدیر", phone: "", address: "", currency: "تومان" },
      customers: state.customers.map(({ id, name, phone, note, tier }) => ({ id, name, phone, note, tier, created_at: new Date().toISOString() })),
      orders: [], staff: [], transactions: [],
    });
  }
  return reply(404, { error: "not_found", message: "یافت نشد" });
}

let server, base, browser;
const contexts = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dokhtyar-srvexport-"));

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

async function openServerApp(role = "admin") {
  state.user.role = role;
  state.session = null;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  contexts.push(ctx);
  await ctx.addInitScript(() => { window.DOKHTYAR_CONFIG = { remote: true, apiBase: "" }; });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  await page.goto(base + "/index.html");
  await page.waitForSelector("#loginGate:not([hidden])");
  await page.fill('#loginForm input[name="email"]', state.user.email);
  await page.fill('#loginForm input[name="password"]', state.user.pw);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#loginGate[hidden]", { state: "attached" });
  await sleep(400);
  return { ctx, page, errors, dialogs };
}

async function download(page, selector) {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }), page.click(selector)]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(file, "utf8") };
}

test("مدیر: پشتیبان ساده‌ی حالت سرور همان داده را دارد و در حالت محلی نمی‌نویسد", async () => {
  state.customers = [{ id: "c-1", name: CUSTOMER, phone: PHONE, note: "", tier: "regular" }];
  const { page, errors, dialogs } = await openServerApp("admin");
  await page.click('.nav-item[data-page="settings"]');
  const dl = await download(page, "#exportBtn");
  assert.equal(dl.name, "dokhtyar-backup.json");
  const data = JSON.parse(dl.text);
  assert.ok(typeof data.exported_at === "string", "شکل سرور دارد: exported_at");
  assert.ok(data.shop, "شکل سرور دارد: shop");
  assert.ok(data.customers.some((c) => c.name === CUSTOMER), "مشتری در پشتیبان است");
  assert.equal(await page.evaluate(() => localStorage.getItem("dokhtyar.v3")), null, "حالت سرور داده‌ی محلی نمی‌نویسد");

  // بررسی همین فایل: معتبر، بدون بازگردانی
  await page.setInputFiles("#backupCheckFile", path.join(tmp, dl.name));
  await page.click("#backupCheckBtn");
  await waitFor(async () => /حالت سرور/.test(await page.textContent("#backupMsg")), "پیام حالت سرور");
  assert.equal(await page.evaluate(() => document.querySelector("#backupRestoreBtn").hidden), true, "بازگردانی حالت سرور نشان داده نمی‌شود");
  assert.deepEqual(errors, []);
  assert.deepEqual(dialogs, []);
});

test("مدیر: پشتیبان رمزشده‌ی حالت سرور بدون متن ساده است و با گذرواژه‌ی درست برمی‌گردد", async () => {
  state.customers = [{ id: "c-2", name: CUSTOMER, phone: PHONE, note: "", tier: "regular" }];
  const { page, errors } = await openServerApp("admin");
  await page.click('.nav-item[data-page="settings"]');
  await page.fill("#backupPassword", PASS);
  await page.fill("#backupPassword2", PASS);
  const dl = await download(page, "#exportEncryptedBtn");
  assert.equal(dl.name, "dokhtyar-backup-encrypted.json");
  assert.equal(dl.text.includes(CUSTOMER), false, "نام مشتری در فایل رمزشده نیست");
  assert.equal(dl.text.includes(PHONE), false, "شماره‌ی تماس در فایل رمزشده نیست");
  assert.equal(await page.inputValue("#backupPassword"), "", "گذرواژه پس از دانلود پاک می‌شود");

  const inner = await page.evaluate(async ([text, pw]) => {
    const r = await BackupCrypto.decryptBackup(text, pw);
    return { kind: r.kind, names: r.data.customers.map((c) => c.name) };
  }, [dl.text, PASS]);
  assert.equal(inner.kind, "server");
  assert.ok(inner.names.includes(CUSTOMER));

  const wrong = await page.evaluate(async (text) => {
    try { await BackupCrypto.decryptBackup(text, "گذرواژه-اشتباه-۱۲۳"); return null; }
    catch (e) { return e.code; }
  }, dl.text);
  assert.equal(wrong, "decrypt_failed", "گذرواژه‌ی نادرست رد می‌شود");
  assert.deepEqual(errors, []);
});

test("غیرمدیر: /export با 403 رد می‌شود، فایلی دانلود نمی‌شود و داده تغییر نمی‌کند", async () => {
  state.customers = [{ id: "c-3", name: CUSTOMER, phone: PHONE, note: "", tier: "regular" }];
  const { page, errors } = await openServerApp("staff");
  await page.click('.nav-item[data-page="settings"]');
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await page.click("#exportBtn");
  await waitFor(async () => /فقط مدیر/.test(await page.textContent("#toast")), "پیام رد دسترسی");
  await sleep(300);
  assert.equal(downloaded, false, "فایلی دانلود نشد");
  assert.deepEqual(errors, []);
});
