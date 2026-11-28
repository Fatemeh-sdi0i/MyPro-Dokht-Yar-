/*
 * Service Worker دوخت‌یار — فاز ۳
 * استراتژی:
 *  - پوسته‌ی برنامه (HTML/CSS/JS/آیکون‌ها) هنگام نصب کش می‌شود (precache).
 *  - ناوبری: شبکه‌ی اول با کش به‌عنوان پشتیبان، تا همیشه آخرین نسخه‌ی ممکن باز شود.
 *  - فایل‌های استاتیک خودِ سایت: کش اول (cache-first) با به‌روزرسانی در پس‌زمینه.
 *
 * هنگام انتشار نسخه‌ی جدید، مقدار VERSION را افزایش دهید تا کش قدیمی حذف شود.
 * مسیرها نسبی هستند تا روی GitHub Pages زیرمسیر (/repo/) هم کار کنند.
 */
const VERSION = "v3.2.16";
const CACHE = `dokhtyar-${VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/config.js",
  "./js/jalali.js",
  "./js/api.js",
  "./js/sync.js",
  "./js/local-store.js",
  "./js/backup-crypto.js",
  "./js/data.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("dokhtyar-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // ناوبری (صفحه‌ها): شبکه اول، در صورت آفلاین بودن نسخه‌ی کش‌شده
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // درخواست‌های API هرگز کش نمی‌شوند: داده‌ی هر مزون و کاربر باید همیشه از سرور و با نشست فعلی بیاید
  if (url.pathname.includes("/api/")) return;

  // دارایی‌های خود سایت: کش اول با به‌روزرسانی در پس‌زمینه
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
