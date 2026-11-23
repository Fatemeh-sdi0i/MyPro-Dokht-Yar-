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
  const BACKUP_KEY = "dokhtyar.backup.v3"; // نسخه‌ی رمزشده‌ی داده‌ی جایگزین‌شده (هیچ‌وقت خودکار حذف نمی‌شود)
  const BACKUP_AAD = "dokhtyar.local.backup";
  const VAULT_CODES = ["vault_unavailable", "no_vault"];
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
  let failVault = false; // فقط آزمون: شبیه‌سازی خطای IndexedDB
  // idb: IndexedDB واقعی؛ none: مرورگر بدون IndexedDB (حالت فقط‌نشست)؛ memory: فقط آزمون‌های Node
  const DEFAULT_VAULT_MODE = root.indexedDB ? "idb" : (typeof window === "undefined" ? "memory" : "none");
  let vaultMode = DEFAULT_VAULT_MODE;
  let busyOps = 0; // عملیات بازیابی در صف؛ تا پایان آن نوشتن معمولی پذیرفته نمی‌شود
  // وضعیت نوشتن برای نشانگر «در حال ذخیره / ذخیره شد». «ذخیره شد» فقط بعد از بازخوانی موفق ثبت می‌شود.
  let listeners = new Set();
  let lastSavedAt = null;
  let lastError = null;
  let chain = Promise.resolve();
  let pending = 0; // نوشتن‌هایی که هنوز به localStorage نرسیده‌اند
  let generation = 0; // هر بارگذاری مجدد نسل تازه می‌سازد؛ نوشتن‌های صفِ نسل قبل دیگر انجام نمی‌شوند
  let status = freshStatus();

  function freshStatus() {
    return {
      ready: false, locked: false, reason: null, staleLegacy: false, legacyCorrupt: false, migrationPending: false,
      persistent: true, sessionOnly: false, legacyKept: false, sessionDirty: false,
    };
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
  // خطای باز شدن IndexedDB «کلید گم شده» نیست: کلید ممکن است سالم باشد. پس خطا را گزارش می‌کنیم
  // و هرگز آن را به‌عنوان نبود کلید تفسیر نمی‌کنیم (وگرنه دکمه‌ی حذف داده‌ی سالم دیده می‌شد).
  function openVaultDb() {
    return new Promise((resolve, reject) => {
      if (failVault) return reject(lockError("vault_unavailable"));
      if (vaultMode === "none") return reject(lockError("no_vault"));
      if (vaultMode === "memory") return resolve(null);
      if (!root.indexedDB) return reject(lockError("vault_unavailable"));
      let req;
      try { req = root.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(lockError("vault_unavailable")); }
      let blocked = false;
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys", { keyPath: "id" });
      };
      req.onsuccess = () => {
        if (blocked) { req.result.close(); return; } // پاسخ دیرهنگام: اتصال باز نمی‌ماند
        resolve(req.result);
      };
      req.onerror = () => reject(lockError("vault_unavailable"));
      req.onblocked = () => { blocked = true; reject(lockError("vault_unavailable")); };
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
  async function seal(text, aad = AAD, allowCreate = storage.getItem(V3_KEY) === null) {
    const key = await getKey(allowCreate);
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, te.encode(text));
    return JSON.stringify({ v: 3, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) });
  }

  async function open(envText, aad = AAD) {
    let env;
    try { env = JSON.parse(envText); } catch (e) { throw lockError("corrupt"); }
    if (!env || env.v !== 3 || typeof env.iv !== "string" || typeof env.ct !== "string") throw lockError("corrupt");
    const key = await getKey(false);
    let pt;
    try {
      pt = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(env.iv), additionalData: te.encode(aad) }, key, fromB64(env.ct));
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
    if (vaultMode === "none") return initSessionOnly();

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
    // کلید را پیش از اولین نوشتن می‌سازیم تا پنجره‌ی ناامن کوتاه بماند (ساخت کلید از IndexedDB کندتر است)
    try { await getKey(true); } catch (err) { /* نوشتن بعدی خطا را گزارش می‌کند */ }
    return status;
  }

  function isReady() { return status.ready && !status.locked; }
  function getStatus() { return { ...status }; }

  /* ---------- نوشتن ---------- */
  // ترتیب نوشتن‌ها حفظ می‌شود؛ هر نوشتن با بازخوانی رمزگشایی تأیید می‌شود
  function save(state) {
    if (!isReady()) return false;
    if (busyOps > 0) return false; // بازیابی در صف است؛ نوشتن معمولی نباید بعد از آن داده‌ی قدیمی بنویسد
    if (!status.persistent) { status.sessionDirty = true; return true; } // حالت فقط‌نشست: چیزی نوشته نمی‌شود
    // وضعیت در همین لحظه ثبت می‌شود؛ تغییرات بعدی نوشتن جدایی می‌سازند
    const text = JSON.stringify(state);
    const myGen = generation;
    pending += 1;
    emit();
    chain = chain
      .then(async () => {
        if (myGen !== generation) return; // صفحه‌ی قبلی بسته شده: نوشتن ناتمام نباید انجام شود
        const env = await seal(text);
        if (myGen !== generation) return;
        storage.setItem(V3_KEY, env); // یک فراخوانی همزمان؛ یا کاملاً نوشته می‌شود یا اصلاً
        const back = await open(storage.getItem(V3_KEY));
        if (back !== text) throw new Error("بازخوانی پس از نوشتن تأیید نشد");
        if (myGen === generation) { lastError = null; lastSavedAt = Date.now(); }
      })
      .catch((err) => {
        if (myGen === generation) lastError = "ذخیره نشد: " + (err && err.message ? err.message : "خطای ناشناخته");
        onError(err);
      })
      .finally(() => { if (myGen === generation) { pending -= 1; emit(); } });
    return true;
  }

  // تعداد نوشتن‌های در انتظار؛ برای هشدار خروج از صفحه
  function pendingCount() { return pending; }

  function writeStatus() {
    const state = !status.persistent ? "session"
      : busyOps > 0 ? "busy"
      : pending > 0 ? "saving"
      : lastError ? "error"
      : lastSavedAt ? "saved" : "idle";
    return { state, pending, lastSavedAt, error: lastError };
  }
  function emit() {
    const snapshot = writeStatus();
    for (const fn of [...listeners]) {
      try { fn(snapshot); } catch (err) { /* یک شنونده‌ی خراب نوشتن را متوقف نمی‌کند */ }
    }
  }
  // فوراً وضعیت فعلی را می‌دهد و بعد از هر تغییر دوباره؛ تابع لغو اشتراک برمی‌گرداند
  function subscribe(fn) {
    listeners.add(fn);
    fn(writeStatus());
    return () => listeners.delete(fn);
  }
  /* ---------- حالت فقط‌نشست (بدون IndexedDB) ---------- */
  // بدون IndexedDB کلید پایدار وجود ندارد، پس هیچ پاکتی نوشته نمی‌شود و داده فقط تا بستن صفحه می‌ماند.
  // نسخه‌ی ساده‌ی قدیمی (v2) فقط خوانده می‌شود و دست‌نخورده می‌ماند.
  function initSessionOnly() {
    if (storage.getItem(V3_KEY) !== null) return lock("no_vault"); // پاکت رمزشده هست ولی بدون IndexedDB باز نمی‌شود
    const v2 = storage.getItem(V2_KEY);
    const legacy = v2 !== null ? tryParse(v2) : null;
    apply(legacy ? sanitize(legacy) : seedFn());
    status = { ...freshStatus(), ready: true, persistent: false, sessionOnly: true, legacyKept: v2 !== null };
    return status;
  }

  /* ---------- بازیابی داده‌ی نسخه‌ی قدیمی ---------- */
  const count = (s) => ({
    customers: s.customers.length, orders: s.orders.length, staff: s.staff.length, transactions: s.transactions.length,
  });

  // زنجیره‌ی نوشتن را دنبال می‌کند؛ تا پایان عملیات، نوشتن معمولی پذیرفته نمی‌شود
  function enqueue(fn) {
    busyOps += 1;
    emit();
    // شمارنده پیش از برگشتن نتیجه به فراخواننده پایین می‌آید، پس وضعیت «بازیابی» نمی‌ماند
    const run = chain.then(async () => {
      try { return await fn(); } finally { busyOps -= 1; emit(); }
    });
    chain = run.catch(() => {});
    return run;
  }

  // برای نمایش در پنل بازیابی: داده‌ی فعلی و داده‌ی نسخه‌ی قدیمی، هر دو با شمارش
  function recoveryInfo() {
    if (!status.ready || status.locked || !status.persistent || !target) return null;
    const v2 = storage.getItem(V2_KEY);
    const backupExists = storage.getItem(BACKUP_KEY) !== null;
    if (v2 === null && !backupExists) return null;
    const legacy = v2 !== null ? tryParse(v2) : null;
    return {
      legacyPresent: v2 !== null,
      legacyCorrupt: v2 !== null && !legacy,
      legacyCounts: legacy ? count(sanitize(legacy)) : null,
      currentCounts: count(target),
      backupExists,
    };
  }

  // داده‌ی نسخه‌ی قدیمی را جایگزین داده‌ی فعلی می‌کند، اما اول داده‌ی فعلی را رمزشده در پشتیبان نگه می‌دارد.
  // هیچ داده‌ای حذف نمی‌شود؛ اگر هر مرحله تأیید نشود، همه‌چیز به حالت قبل برمی‌گردد.
  function importLegacy() {
    return enqueue(async () => {
      if (!status.ready || status.locked || !status.persistent) throw new Error("ورود داده‌ی قدیمی در این حالت ممکن نیست");
      const v2 = storage.getItem(V2_KEY);
      if (v2 === null) throw new Error("نسخه‌ی ساده‌ی قدیمی‌ای برای ورود وجود ندارد");
      if (storage.getItem(BACKUP_KEY) !== null) throw new Error("یک پشتیبان قبلی هست؛ ابتدا آن را بررسی یا جابه‌جا کنید");
      const legacy = tryParse(v2);
      if (!legacy) throw new Error("نسخه‌ی ساده‌ی قدیمی خراب است؛ دست‌نخورده مانده است");
      const clean = sanitize(legacy);
      const expected = JSON.stringify(clean);
      const v3Before = storage.getItem(V3_KEY);
      if (v3Before === null) throw new Error("داده‌ی رمزشده‌ی فعلی وجود ندارد؛ بازیابی انجام نشد");
      const currentText = await open(v3Before);
      let backupWritten = false;
      try {
        storage.setItem(BACKUP_KEY, await seal(currentText, BACKUP_AAD, false));
        backupWritten = true;
        if ((await open(storage.getItem(BACKUP_KEY), BACKUP_AAD)) !== currentText) throw new Error("بازخوانی پشتیبان تأیید نشد");
        storage.setItem(V3_KEY, await seal(expected));
        if ((await open(storage.getItem(V3_KEY))) !== expected) throw new Error("بازخوانی داده‌ی بازیابی‌شده تأیید نشد");
      } catch (err) {
        storage.setItem(V3_KEY, v3Before);
        if (backupWritten) storage.removeItem(BACKUP_KEY);
        throw new Error("بازیابی انجام نشد و داده‌ی فعلی دست‌نخورده است (" + err.message + ")");
      }
      storage.removeItem(V2_KEY); // فقط بعد از تأیید هر دو نسخه
      apply(clean);
      status.staleLegacy = false;
      lastError = null; lastSavedAt = Date.now();
      return count(clean);
    });
  }

  // جابه‌جایی داده‌ی اصلی و پشتیبان؛ هیچ‌چیز حذف نمی‌شود و تکرار آن برگشت است
  function swapWithBackup() {
    return enqueue(async () => {
      if (!status.ready || status.locked || !status.persistent) throw new Error("جابه‌جایی در این حالت ممکن نیست");
      const bak = storage.getItem(BACKUP_KEY);
      if (bak === null) throw new Error("پشتیبانی برای جابه‌جایی وجود ندارد");
      const curEnv = storage.getItem(V3_KEY);
      const curText = await open(curEnv);
      const bakText = await open(bak, BACKUP_AAD);
      const restored = tryParse(bakText);
      if (!restored) throw new Error("پشتیبان خراب است؛ هیچ‌چیز تغییر نکرد");
      const clean = sanitize(restored);
      try {
        storage.setItem(V3_KEY, await seal(bakText));
        storage.setItem(BACKUP_KEY, await seal(curText, BACKUP_AAD, false));
        if ((await open(storage.getItem(V3_KEY))) !== bakText) throw new Error("بازخوانی تأیید نشد");
        if ((await open(storage.getItem(BACKUP_KEY), BACKUP_AAD)) !== curText) throw new Error("بازخوانی تأیید نشد");
      } catch (err) {
        storage.setItem(V3_KEY, curEnv);
        storage.setItem(BACKUP_KEY, bak);
        throw new Error("جابه‌جایی انجام نشد و داده‌ی فعلی دست‌نخورده است (" + err.message + ")");
      }
      apply(clean);
      lastError = null; lastSavedAt = Date.now();
      return count(clean);
    });
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
      if (VAULT_CODES.includes(err.code)) throw new Error("دسترسی به کلید مرورگر برقرار نیست؛ هیچ‌چیز حذف نشد");
      if (!UNREADABLE.includes(err.code)) throw err;
    }
    storage.removeItem(V3_KEY);
    status = freshStatus();
    return true;
  }

  // فقط برای آزمون‌ها: پاک کردن کلید حافظه‌ای و کش، و شبیه‌سازی از دست رفتن کلید
  const testing = {
    dropKey() { memoryKeyRecord = null; keyCache = null; },
    setVaultFailure(on) { failVault = Boolean(on); keyCache = null; },
    setVaultMode(mode) { vaultMode = mode; },
    openAny: (env, aad) => open(env, aad), // فقط برای بررسی پشتیبان در آزمون‌ها
    // شبیه‌سازی بارگذاری مجدد صفحه: کلید (که در IndexedDB است) می‌ماند، کش و صف نوشتن پاک می‌شود.
    // نسل جدید: نوشتن‌های صفِ صفحه‌ی قبلی انجام نمی‌شوند؛ حالت‌های آزمون به پیش‌فرض برمی‌گردند
    reset() {
      generation += 1; pending = 0; busyOps = 0; failVault = false; vaultMode = DEFAULT_VAULT_MODE; keyCache = null;
      chain = Promise.resolve(); status = freshStatus(); lastSavedAt = null; lastError = null; listeners = new Set();
    },
  };

  root.LocalStore = {
    init, save, isReady, getStatus, readPlain, deleteUnreadable, flush: () => chain, pendingCount,
    recoveryInfo, importLegacy, swapWithBackup, subscribe, getWriteStatus: writeStatus,
    V2_KEY, V3_KEY, BACKUP_KEY, UNREADABLE, testing,
  };
})(typeof window !== "undefined" ? window : globalThis);
