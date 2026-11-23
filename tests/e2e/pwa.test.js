// تست مرورگری PWA در حالت محلی (بدون API): ثبت سرویس‌ورکر، کش پوسته، بارگذاری و ناوبری آفلاین.
// فهرست فایل‌های پوسته از خود sw.js خوانده می‌شود تا با آن هم‌گام بماند.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

const swSource = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const VERSION = swSource.match(/const VERSION = "([^"]+)"/)[1];
const CACHE = `dokhtyar-${VERSION}`;
const APP_SHELL = [...swSource.matchAll(/"(\.\/[^"]*)"/g)].map((m) => m[1]);

let server, base, browser, ctx, page;
const pageErrors = [];

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
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow" });
  page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/index.html");
  // بار اول: سرویس‌ورکر نصب و فعال می‌شود، سپس صفحه یک‌بار بارگذاری مجدد می‌شود تا کنترل را بگیرد
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 })
    .catch(() => page.reload());
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
});

after(async () => {
  await browser?.close();
  server?.close();
});

test("manifest و سرویس‌ورکر فعال هستند", async () => {
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const res = await fetch(link.href);
    return { status: res.status, ok: (await res.json()).name !== undefined };
  });
  assert.equal(manifest.status, 200);
  assert.equal(manifest.ok, true);
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { active: Boolean(r && r.active), scope: r && r.scope };
  });
  assert.equal(reg.active, true);
});

test("همه‌ی فایل‌های پوسته در کش نسخه‌ی فعلی هستند", async () => {
  const missing = await page.evaluate(async ({ cacheName, files, origin }) => {
    const cache = await caches.open(cacheName);
    const out = [];
    for (const f of files) {
      const url = new URL(f, origin + "/index.html").href;
      if (!(await cache.match(url))) out.push(f);
    }
    return out;
  }, { cacheName: CACHE, files: APP_SHELL, origin: base });
  assert.deepEqual(missing, [], "فایل‌های کش‌نشده: " + missing.join(", "));
});

test("کش نسخه‌ی قدیمی حذف شده و کش API وجود ندارد", async () => {
  const keys = await page.evaluate(() => caches.keys());
  const oldCaches = keys.filter((k) => k.startsWith("dokhtyar-") && k !== CACHE);
  assert.deepEqual(oldCaches, [], "کش قدیمی باقی مانده");
  const apiEntries = await page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    return (await cache.keys()).filter((r) => r.url.includes("/api/")).length;
  }, CACHE);
  assert.equal(apiEntries, 0, "پاسخ API نباید در کش پوسته باشد");
});

test("بارگذاری مجدد آفلاین: برنامه بدون خطا بالا می‌آید", async () => {
  await ctx.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".nav-item", { timeout: 10000 });
    const navCount = await page.locator(".nav-item").count();
    assert.ok(navCount > 0, "منوی برنامه باید نمایش داده شود");
  } finally {
    await ctx.setOffline(false);
  }
});

test("ناوبری بین صفحه‌ها در حالت آفلاین کار می‌کند", async () => {
  await ctx.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".nav-item", { timeout: 10000 });
    await page.click('.nav-item[data-page="orders"]');
    await page.waitForSelector("#orders.page.active", { timeout: 5000 });
    await page.click('.nav-item[data-page="settings"]');
    await page.waitForSelector("#settings.page.active", { timeout: 5000 });
  } finally {
    await ctx.setOffline(false);
  }
});

test("هیچ خطای صفحه‌ای ثبت نشده است", () => {
  assert.deepEqual(pageErrors, []);
});
