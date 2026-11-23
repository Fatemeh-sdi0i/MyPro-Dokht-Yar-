/*
 * ذخیره‌سازی رمزنگاری‌شده‌ی حالت محلی (localStorage).
 *
 * - قالب جدید: کلید "dokhtyar.v3" با یک پاکت JSON: {v:3, iv, ct} (base64، AES-GCM).
 * - کلید رمز: AES-GCM غیرقابل استخراج در IndexedDB جداگانه ("dokhtyar-vault"). مواد کلید هرگز خارج از WebCrypto نمی‌رود.
 * - AAD = نام داده ("dokhtyar.local.v3") تا پاکت از جای دیگری قابل استفاده نباشد.
 * - مهاجرت: "dokhtyar.v2" (ساده) فقط بعد از نوشتن و بازخوانی موفق رمزشده‌ی یکسان حذف می‌شود.
 *   اگر نسخه‌ی ساده‌ی دیگری بعد از مهاجرت بماند، دست‌نخورده می‌ماند و هشدار داده می‌شود.
 * - قفل امن: اگر پاکت رمزشده هست ولی کلید نیست یا رمز باز نمی‌شود، هیچ نوشتنی انجام نمی‌شود
 *   (وگرنه داده‌ی قابل بازیابی بی‌صدا بازنویسی می‌شد). فقط با تأیید دوگانه‌ی کاربر، همان پاکت ناخوانا حذف می‌شود.
 * - نوشتن‌ها به ترتیب انجام می‌شوند و هر نوشتن بازخوانی و رمزگشایی می‌شود.
 */
(function (root) {
  const V2_KEY = "dokhtyar.v2";
  const V3_KEY = "dokhtyar.v3";
  const DB_NAME = "dokhtyar-vault";
  const DB_VERSION = 1;
  const KEY_ID = "local";
  const AAD = "dokhtyar.local.v3";
  const UNREADABLE = ["key_missing", "decrypt_failed", "corrupt"];

  const te = new TextEncoder();
  const td = new TextDecoder();
  const subtle = () => (root.crypto && root.crypto.subtle) || null;

  let storage = null;
  let target = null;
  let seedFn = null;
  let onError = () => {};
  let keyCache = null;
  let memoryKeyRecord = null; // جایگزین وقتی IndexedDB نیست (آزمون‌ها و محیط‌های بدون IndexedDB)
  let chain = Promise.resolve();
  let status = freshStatus();

  function freshStatus() {
    return { ready: false, locked: false, reason: null, staleLegacy: false, legacyCorrupt: false, migrationPending: false };
  }

  function lockError(code) {
    const e = new Error("داده‌ی محلی قابل خواندن نیست");
    e.code = code;
    return e;
  }

  /* ---------- base64 ---------- */
  function toB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(text) {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------- کلید ---------- */
  function openVaultDb() {
    return new Promise((resolve) => {
      if (!root.indexedDB) return resolve(null);
      let req;
      try { req = root.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }

  async function readKeyRecord() {
    const db = await openVaultDb();
    if (!db) return memoryKeyRecord;
    return new Promise((resolve, reject) => {
      const req = db.transaction("keys", "readonly").objectStore("keys").get(KEY_ID);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  // ساخت کلید فقط در یک تراکنش با بررسی وجود قبلی، تا دو زبانه دو کلید متفاوت نسازند
  async function putKeyIfAbsent(key) {
    const db = await openVaultDb();
    if (!db) {
      if (!memoryKeyRecord) memoryKeyRecord = { id: KEY_ID, key, createdAt: Date.now() };
      return memoryKeyRecord.key;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      const s = tx.objectStore("keys");
      let existing = null;
      const g = s.get(KEY_ID);
      g.onsuccess = () => {
        existing = g.result || null;
        if (!existing) s.put({ id: KEY_ID, key, createdAt: Date.now() });
      };
      tx.oncomplete = () => { db.close(); resolve(existing ? existing.key : key); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  // allowCreate فقط وقتی true است که هیچ پاکت رمزشده‌ای وجود ندارد
  async function getKey(allowCreate) {
    if (keyCache) return keyCache;
    const rec = await readKeyRecord();
    if (rec && rec.key) { keyCache = rec.key; return keyCache; }
    if (!allowCreate) throw lockError("key_missing");
    if (!subtle()) throw lockError("no_webcrypto");
    const fresh = await subtle().generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    keyCache = await putKeyIfAbsent(fresh);
    return keyCache;
  }

  /* ---------- رمز ---------- */
  async function seal(text) {
    const allowCreate = storage.getItem(V3_KEY) === null;
    const key = await getKey(allowCreate);
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: te.encode(AAD) }, key, te.encode(text));
    return JSON.stringify({ v: 3, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) });
  }

  async function open(envText) {
    let env;
    try { env = JSON.parse(envText); } catch (e) { throw lockError("corrupt"); }
    if (!env || env.v !== 3 || typeof env.iv !== "string" || typeof env.ct !== "string") throw lockError("corrupt");
    const key = await getKey(false);
    let pt;
    try {
      pt = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(env.iv), additionalData: te.encode(AAD) }, key, fromB64(env.ct));
    } catch (e) {
      throw lockError("decrypt_failed");
    }
    return td.decode(pt);
  }

  /* ---------- شکل داده ---------- */
  function tryParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // همان فیلدهایی که قبلاً loadState می‌پذیرفت؛ داده‌ی ناقص با نمونه کامل می‌شود
  function sanitize(parsed) {
    const seed = seedFn();
    const p = parsed && typeof parsed === "object" ? parsed : {};
    return {
      orders: Array.isArray(p.orders) ? p.orders : seed.orders,
      customers: Array.isArray(p.customers) ? p.customers : seed.customers,
      staff: Array.isArray(p.staff) ? p.staff : seed.staff,
      transactions: Array.isArray(p.transactions) ? p.transactions : seed.transactions,
      settings: { ...seed.settings, ...(p.settings || {}) },
    };
  }

  function apply(clean) {
    if (target) Object.assign(target, clean);
  }

  function lock(reason) {
    status = { ...freshStatus(), ready: false, locked: true, reason };
    return status;
  }

  /* ---------- راه‌اندازی ---------- */
  /**
   * opts: {storage, target (شیء state که پر می‌شود؛ null یعنی فقط مهاجرت), seed (تابع نمونه), onError}
   * نتیجه: وضعیت. تا وقتی ready نشده، نوشتنی انجام نمی‌شود.
   */
  async function init(opts) {
    storage = opts.storage;
    target = opts.target || null;
    seedFn = opts.seed;
    onError = opts.onError || (() => {});
    keyCache = null;
    status = freshStatus();

    const v3 = storage.getItem(V3_KEY);
    const v2 = storage.getItem(V2_KEY);

    if (v3 !== null) {
      let clean;
      try {
        const parsed = tryParse(await open(v3));
        if (parsed === null) return lock("corrupt");
        clean = sanitize(parsed);
      } catch (err) {
        return lock(err.code || "decrypt_failed");
      }
      apply(clean);
      status.ready = true;
      if (v2 !== null) {
        const legacy = tryParse(v2);
        if (legacy && JSON.stringify(sanitize(legacy)) === JSON.stringify(clean)) {
          storage.removeItem(V2_KEY); // نسخه‌ی ساده‌ی قبلی همان داده است
        } else {
          status.staleLegacy = true; // نسخه‌ی ساده‌ی دیگری مانده؛ دست‌نخورده می‌ماند
        }
      }
      return status;
    }

    if (v2 !== null) {
      const legacy = tryParse(v2);
      if (!legacy) {
        // ساده و خراب: دست‌نخورده می‌ماند؛ نوشتن‌ها فقط در قالب جدید انجام می‌شود
        apply(seedFn());
        status.ready = true;
        status.legacyCorrupt = true;
        return status;
      }
      const clean = sanitize(legacy);
      apply(clean);
      status.ready = true;
      const expected = JSON.stringify(clean);
      try {
        storage.setItem(V3_KEY, await seal(expected));
        const back = await open(storage.getItem(V3_KEY));
        if (back === expected) storage.removeItem(V2_KEY); // فقط بعد از تأیید بازخوانی
        else status.migrationPending = true;
      } catch (err) {
        status.migrationPending = true;
      }
      return status;
    }

    apply(seedFn());
    status.ready = true;
    return status;
  }

  function isReady() { return status.ready && !status.locked; }
  function getStatus() { return { ...status }; }

  /* ---------- نوشتن ---------- */
  // ترتیب نوشتن‌ها حفظ می‌شود؛ هر نوشتن با بازخوانی رمزگشایی تأیید می‌شود
  function save(state) {
    if (!isReady()) return false;
    const text = JSON.stringify(state);
    chain = chain
      .then(async () => {
        const env = await seal(text);
        storage.setItem(V3_KEY, env);
        const back = await open(storage.getItem(V3_KEY));
        if (back !== text) throw new Error("بازخوانی پس از نوشتن تأیید نشد");
      })
      .catch((err) => onError(err));
    return true;
  }

  // برای خواندن داده‌ی ساده در حالت سرور (انتقال یک‌باره) — بدون تغییر حالت
  async function readPlain() {
    const v3 = storage.getItem(V3_KEY);
    if (v3 !== null) {
      try { return tryParse(await open(v3)); } catch (err) { return null; }
    }
    const v2 = storage.getItem(V2_KEY);
    return v2 ? tryParse(v2) : null;
  }

  /**
   * حذف فقط پاکت رمزشده‌ی ناخوانا. داده‌ی قابل‌خواندن، نسخه‌ی ساده و کلید حذف نمی‌شوند.
   * پیش از حذف دوباره بررسی می‌شود که پاکت واقعاً ناخواناست.
   */
  async function deleteUnreadable() {
    const v3 = storage.getItem(V3_KEY);
    if (v3 === null) throw new Error("داده‌ی رمزشده‌ای برای حذف وجود ندارد");
    try {
      await open(v3);
      throw new Error("این داده قابل‌خواندن است و حذف نمی‌شود");
    } catch (err) {
      if (!UNREADABLE.includes(err.code)) throw err;
    }
    storage.removeItem(V3_KEY);
    status = freshStatus();
    return true;
  }

  // فقط برای آزمون‌ها: پاک کردن کلید حافظه‌ای و کش، و شبیه‌سازی از دست رفتن کلید
  const testing = {
    dropKey() { memoryKeyRecord = null; keyCache = null; },
    // شبیه‌سازی بارگذاری مجدد صفحه: کلید (که در IndexedDB است) می‌ماند، کش و صف نوشتن پاک می‌شود
    reset() { keyCache = null; chain = Promise.resolve(); status = freshStatus(); },
  };

  root.LocalStore = {
    init, save, isReady, getStatus, readPlain, deleteUnreadable, flush: () => chain,
    V2_KEY, V3_KEY, UNREADABLE, testing,
  };
})(typeof window !== "undefined" ? window : globalThis);
