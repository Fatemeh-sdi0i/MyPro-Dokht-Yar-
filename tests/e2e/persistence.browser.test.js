// تست مرورگری ماندگاری داده‌ی حالت محلی (navigator.storage.persist).
// فقط Chromium در این فایل اجرا می‌شود؛ رفتار واقعی هر مرورگر در CI و دستگاه‌ها جدا بررسی می‌شود.
// هیچ داده‌ی واقعی وارد نمی‌شود؛ کانتکست‌ها جدا و موقت هستند.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = process.env.DOKHTYAR_ROOT || path.resolve(__dirname, "../..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

const MSG = {
  granted: "ماندگاری داده: فعال است. مرورگر داده را خودکار پاک نمی‌کند؛ با این حال پشتیبان JSON را منظم نگه دارید.",
  denied: "ماندگاری داده: مرورگر اجازه‌ی ماندگاری دائمی نداد. داده ممکن است در شرایط کمبود فضا پاک شود؛ پشتیبان JSON را منظم دانلود کنید.",
  unsupported: "ماندگاری داده: این مرورگر درخواست ماندگاری را پشتیبانی نمی‌کند. پشتیبان JSON را منظم دانلود کنید.",
};

let server, base, browser;
const pageErrors = [];
const contexts = [];

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
});

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  server?.close();
});

// mode: "default" | "denied" | "unsupported" | "throws"
async function openApp(mode) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contexts.push(ctx);
  if (mode !== "default") {
    await ctx.addInitScript((m) => {
      const fake = {
        persisted: async () => false,
        persist: async () => false,
      };
      if (m === "throws") fake.persist = async () => { throw new Error("blocked"); };
      Object.defineProperty(navigator, "storage", {
        get: () => (m === "unsupported" ? undefined : fake),
        configurable: true,
      });
    }, mode);
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(base + "/index.html");
  await page.waitForSelector("body[data-ready]", { timeout: 10000 });
  await page.waitForFunction(() => (document.querySelector("#persistText")?.textContent || "").length > 0, null, { timeout: 8000 });
  return page;
}

const text = (page) => page.evaluate(() => document.querySelector("#persistText").textContent);

test("Chromium: یکی از سه پیام معتبر نمایش داده می‌شود و برنامه بالا می‌آید", async () => {
  const page = await openApp("default");
  assert.ok(Object.values(MSG).includes(await text(page)), "پیام ماندگاری معتبر است");
  assert.equal(await page.evaluate(() => document.querySelector("#persistText").hidden), false);
});

test("مرورگر اجازه نداد: پیام «اجازه داده نشد» نمایش داده می‌شود", async () => {
  const page = await openApp("denied");
  assert.equal(await text(page), MSG.denied);
});

test("مرورگر StorageManager ندارد: پیام «پشتیبانی نمی‌شود» نمایش داده می‌شود", async () => {
  const page = await openApp("unsupported");
  assert.equal(await text(page), MSG.unsupported);
});

test("خطای persist برنامه را نمی‌شکند و پیام «اجازه داده نشد» را نشان می‌دهد", async () => {
  const page = await openApp("throws");
  assert.equal(await text(page), MSG.denied);
  // برنامه کار کند: ورود به تنظیمات بدون خطا
  await page.click('.nav-item[data-page="settings"]');
  assert.equal(await page.evaluate(() => document.querySelector("#settingsForm") !== null), true);
});

test("هیچ خطای صفحه‌ای در همه‌ی سناریوها ثبت نشده است", () => {
  assert.deepEqual(pageErrors, []);
});
