/*
 * همگام‌سازی آفلاین دوخت‌یار (حالت سرور).
 * - هر تغییر با شناسه‌ی کاربر (scope) برچسب می‌خورد؛ صف و کش هر کاربر از بقیه جداست.
 * - فقط خطاهای دائمی سرور (۴xx به‌جز ۴۰۸، ۴۲۹ و ۴۲۵) عملیات را به فهرست ردشده می‌برند.
 *   خطاهای موقت (۵xx، ۴۲۹، ۴۰۸، نبود اتصال، ناشناخته) صف را دست‌نخورده نگه می‌دارند.
 * - ۴۰۱ ارسال را متوقف می‌کند و صف حذف نمی‌شود.
 * - خروج به‌صورت عملیات صف است و آخرین عملیات همان کاربر می‌ماند؛ نشست سرور بعد از ارسال‌شدن همه‌ی تغییرات باطل می‌شود.
 * - ایجاد با شناسه‌ی UUID روی کلاینت ساخته می‌شود؛ تکرار ارسال ایمن است.
 */
(function (root) {
  const DB_NAME = "dokhtyar-sync";
  const DB_VERSION = 2;
  const LOGOUT_PATH = "/auth/logout";
  const KEY_OF = { queue: "opId", rejected: "opId", cache: "key", keys: "id" };
  const memory = { queue: new Map(), rejected: new Map(), cache: new Map(), keys: new Map() };
  // فیلدهای بدون رمز (برای شناسایی و ترتیب)؛ بقیه‌ی فیلدهای این فروشگاه‌ها رمزنگاری می‌شوند
  const CLEAR_FIELDS = {
    queue: ["opId", "scope", "method", "path", "order", "createdAt"],
    rejected: ["opId", "scope", "method", "path", "order", "createdAt", "rejectedAt", "code"],
    cache: ["key"],
  };
  const SEALED_STORES = Object.keys(CLEAR_FIELDS);
  const LOCKED_MSG = "داده‌های همگام‌نشده‌ی این مرورگر قابل خواندن نیستند؛ هیچ‌چیزی حذف نشده است.";
  const TRANSIENT_4XX = new Set([408, 425, 429]);
  let dbPromise = null;
  let scope = null; // شناسه‌ی کاربر فعلی
  let lastTs = 0;
  let lastN = 0;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!root.indexedDB) return resolve(null);
      let req;
      try { req = root.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of Object.keys(KEY_OF)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: KEY_OF[name] });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  // نتیجه: {value} یا null اگر IndexedDB در دسترس نباشد (آنگاه حافظه‌ی صفحه استفاده می‌شود)
  async function store(name, mode, fn) {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve({ value: req ? req.result : undefined });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /* ---------- رمزنگاری در حالت ذخیره ----------
   * کلید AES-GCM روی دستگاه، غیرقابل استخراج است و در همان IndexedDB نگه‌داری می‌شود.
   * فیلدهای حساس (نام، شماره، توضیح، مبلغ‌ها و کش) رمز می‌شوند؛ شناسه‌ها بدون رمز می‌مانند.
   * AAD = نام فروشگاه + کلید رکورد، پس جابه‌جا کردن رکوردها شناسایی می‌شود.
   * رکوردهای قدیمی ساده خوانده می‌شوند و با migrateLocalData رمز می‌شوند.
   * کلید گم شود و رکورد رمزشده مانده باشد: هیچ کلید تازه‌ای ساخته نمی‌شود (داده بی‌صدا از بین نمی‌رود)،
   * رکوردها «قابل‌خواندن‌نیستند» علامت می‌خورند و ارسال متوقف می‌شود. */
  const te = new TextEncoder();
  const td = new TextDecoder();
  const subtle = () => (root.crypto && root.crypto.subtle) || null;
  let deviceKeyCache = null;

  function localError(code, message) {
    const e = new Error(message || LOCKED_MSG);
    e.code = code;
    e.localData = true;
    return e;
  }
  const isLocalDataError = (err) => Boolean(err && err.localData);

  async function rawAll(name) {
    const r = await store(name, "readonly", (s) => s.getAll());
    return r ? (r.value || []) : [...memory[name].values()];
  }
  async function rawGet(name, key) {
    const r = await store(name, "readonly", (s) => s.get(key));
    return r ? (r.value || null) : (memory[name].get(key) || null);
  }
  async function rawPut(name, rec) {
    const r = await store(name, "readwrite", (s) => s.put(rec));
    if (!r) memory[name].set(rec[KEY_OF[name]], rec);
  }
  async function del(name, key) {
    const r = await store(name, "readwrite", (s) => s.delete(key));
    if (!r) memory[name].delete(key);
  }

  async function loadDeviceKey() {
    if (deviceKeyCache) return deviceKeyCache;
    const rec = await rawGet("keys", "device");
    if (rec && rec.key) deviceKeyCache = rec.key;
    return deviceKeyCache;
  }

  // کلید را فقط وقتی بساز که رکورد رمزشده‌ای وجود ندارد؛ ساخت در همان تراکنش خواندن و نوشتن، پس دو برگه کلید متفاوت نمی‌سازند
  async function putDeviceKeyIfAbsent(key) {
    const db = await openDb();
    if (!db) {
      const cur = memory.keys.get("device");
      if (cur) return cur.key;
      memory.keys.set("device", { id: "device", key, createdAt: Date.now() });
      return key;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      const s = tx.objectStore("keys");
      let existing = null;
      const g = s.get("device");
      g.onsuccess = () => {
        existing = g.result || null;
        if (!existing) s.put({ id: "device", key, createdAt: Date.now() });
      };
      tx.oncomplete = () => resolve(existing ? existing.key : key);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function hasSealedRecords() {
    for (const name of SEALED_STORES) {
      if ((await rawAll(name)).some((r) => r && r.sealed)) return true;
    }
    return false;
  }

  async function ensureDeviceKey() {
    const existing = await loadDeviceKey();
    if (existing) return existing;
    if (await hasSealedRecords()) throw localError("key_missing");
    const fresh = await subtle().generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    deviceKeyCache = await putDeviceKeyIfAbsent(fresh);
    return deviceKeyCache;
  }

  async function seal(name, recKey, secret) {
    const key = await ensureDeviceKey();
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt(
      { name: "AES-GCM", iv, additionalData: te.encode(`${name}|${recKey}`) }, key, te.encode(JSON.stringify(secret)));
    return { v: 1, iv, ct: new Uint8Array(ct) };
  }

  // شکل ذخیره‌شده: فیلدهای بدون رمز + sealed. بدون WebCrypto رکورد ساده ذخیره می‌شود (فقط در بافت غیرامن).
  async function toStored(name, rec) {
    if (!SEALED_STORES.includes(name) || !subtle()) return rec;
    const clearNames = CLEAR_FIELDS[name];
    const clear = {};
    const secret = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === "unreadable" || k === "unreadableCode") continue;
      (clearNames.includes(k) ? clear : secret)[k] = v;
    }
    const sealed = await seal(name, rec[KEY_OF[name]], secret);
    return { ...clear, sealed };
  }

  // رکورد خوانده‌شده: اگر رمزنگاری نشده یا رمز باز شد، کامل؛ وگرنه unreadable=true و فیلدهای رمزشده نیستند
  async function fromStored(name, rec) {
    if (!rec || !rec.sealed) return rec;
    const { sealed, ...clear } = rec;
    try {
      const key = await loadDeviceKey();
      if (!key) throw localError("key_missing");
      const pt = await subtle().decrypt(
        { name: "AES-GCM", iv: sealed.iv, additionalData: te.encode(`${name}|${clear[KEY_OF[name]]}`) }, key, sealed.ct);
      return { ...clear, ...JSON.parse(td.decode(pt)) };
    } catch (err) {
      return { ...clear, unreadable: true, unreadableCode: (err && err.code) || "decrypt_failed" };
    }
  }

  async function put(name, rec) {
    const stored = await toStored(name, rec);
    await rawPut(name, stored);
  }
  async function get(name, key) {
    return fromStored(name, await rawGet(name, key));
  }
  async function all(name) {
    const rows = await rawAll(name);
    return Promise.all(rows.map((r) => fromStored(name, r)));
  }

  // تبدیل رکوردهای قدیمی (ساده) به شکل رمزشده. هر رکورد جداگانه و ایمن است؛ قطع وسط کار بی‌خطر است.
  // جایگزینی فقط وقتی انجام می‌شود که رکورد هنوز ساده است (اگر در این فاصله تغییر کرده، دست نمی‌زنیم).
  async function replaceIfStillPlain(name, recKey, sealedRec) {
    const db = await openDb();
    if (!db) {
      const cur = memory[name].get(recKey);
      if (!cur || cur.sealed) return false;
      memory[name].set(recKey, sealedRec);
      return true;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readwrite");
      const s = tx.objectStore(name);
      let replaced = false;
      const g = s.get(recKey);
      g.onsuccess = () => {
        const cur = g.result;
        if (cur && !cur.sealed) { s.put(sealedRec); replaced = true; }
      };
      tx.oncomplete = () => resolve(replaced);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function migrateLocalData() {
    if (!subtle()) return { migrated: 0, skipped: true };
    let migrated = 0;
    for (const name of SEALED_STORES) {
      for (const rec of await rawAll(name)) {
        if (!rec || rec.sealed) continue;
        const sealedRec = await toStored(name, rec);
        if (await replaceIfStillPlain(name, rec[KEY_OF[name]], sealedRec)) migrated += 1;
      }
    }
    return { migrated, skipped: false };
  }

  // وضعیت برای رابط: چند تغییر در صف یا ردشده قابل خواندن نیست
  async function localDataStatus() {
    let unreadable = 0;
    for (const name of ["queue", "rejected"]) {
      unreadable += (await all(name)).filter((r) => r.unreadable).length;
    }
    return { encrypted: Boolean(subtle()), unreadable };
  }

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    const b = new Uint8Array(16);
    root.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // ترتیب ثابت و صعودی: زمان به میلی‌ثانیه و شماره‌ی ترتیب در همان میلی‌ثانیه
  function nextOrder() {
    const ts = Date.now();
    if (ts === lastTs) lastN += 1;
    else { lastTs = ts; lastN = 0; }
    return ts * 1000 + lastN;
  }

  const isNetworkError = (err) => Boolean(err) && err.status === 0;

  // خطای دائمی: ۴xx به‌جز ۴۰۱ (جداگانه) و خطاهای موقت
  const isPermanent = (err) => Boolean(err) && typeof err.status === "number" &&
    err.status >= 400 && err.status < 500 && err.status !== 401 && !TRANSIENT_4XX.has(err.status);

  // حذف یا به‌روزرسانی ردیفی که دیگر نیست یعنی همین کار قبلاً انجام شده است
  const isAlreadyGone = (op, err) => err.status === 404 && (
    op.method === "DELETE" || op.method === "PATCH" || (op.method === "POST" && /\/status$/.test(op.path)));

  /* ---------- نشست ---------- */

  // بعد از ورود موفق. عملیات خروج قدیمی همین کاربر (نشست قبلی) حذف می‌شود، چون نشست جدید نباید باطل شود.
  async function beginSession(userId) {
    scope = userId || null;
    if (!scope) return;
    // نشانه‌ی آخرین کاربر یک بهینه‌سازی برای بوت آفلاین است؛ اگر داده‌ی محلی قفل باشد ورود را نباید مسدود کند
    try { await put("cache", { key: "last", userId: scope }); } catch (err) { if (!isLocalDataError(err)) throw err; }
    for (const op of (await all("queue")).filter((o) => o.scope === scope && o.path === LOGOUT_PATH)) {
      await del("queue", op.opId);
    }
    await del("cache", "logout:" + scope);
  }

  // پایان نشست بدون خروج از سرور (مثلاً ۴۰۱): کش نمایشی پاک می‌شود، صف می‌ماند
  async function endSession() {
    const uid = scope;
    scope = null;
    if (uid) await del("cache", "snapshot:" + uid);
    const last = await get("cache", "last");
    if (last) await del("cache", "last");
  }

  // آخرین کاربری که نشستش معتبر بوده (برای بوت آفلاین)؛ بدون نشانه، نمایش داده‌ی کش انجام نمی‌شود
  async function lastScope() {
    const rec = await get("cache", "last");
    return rec && !rec.unreadable ? rec.userId : null;
  }

  function currentUser() { return scope; }

  /* ---------- صف ---------- */

  async function pendingOps() {
    if (!scope) return [];
    const ops = (await all("queue")).filter((o) => o.scope === scope);
    return ops.sort((a, b) => a.order - b.order);
  }

  // تعداد تغییرات داده (بدون عملیات خروج)
  async function pendingCount() {
    return (await pendingOps()).filter((o) => o.path !== LOGOUT_PATH).length;
  }

  // meta توضیح کوتاه برای نمایش در فهرست ردشده‌ها است (عنوان و جزئیات)، نه داده‌ی تازه.
  function cleanMeta(meta) {
    if (!meta || typeof meta !== "object") return null;
    const clip = (v) => String(v || "").slice(0, 120);
    return { title: clip(meta.title), detail: clip(meta.detail) };
  }

  async function enqueue(method, path, body, meta) {
    if (!scope) throw new Error("نشست فعال نیست");
    const op = { opId: uuid(), scope, method, path, body, meta: cleanMeta(meta), createdAt: Date.now(), order: nextOrder() };
    await put("queue", op);
    return op;
  }

  /**
   * ارسال یک تغییر. اگر اتصال نباشد در صف می‌ماند و queued=true برمی‌گرداند.
   * سایر خطاها (اعتبارسنجی، دسترسی) به فراخواننده برمی‌گردند.
   */
  async function send(method, path, body, meta) {
    try {
      await root.Api.call(method, path, body);
      return { queued: false };
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      await enqueue(method, path, body, meta);
      return { queued: true };
    }
  }

  // عملیات ردشده با کد خطای سرور (مثلاً version_conflict) ذخیره می‌شود تا رابط بتواند کمک کند
  async function reject(op, reason, code) {
    await put("rejected", { ...op, reason, code: code || null, rejectedAt: Date.now() });
    await del("queue", op.opId);
  }

  /** یک عملیات ردشده‌ی همین نشست (یا null) */
  async function rejectedOp(opId) {
    const rec = await get("rejected", opId);
    return rec && rec.scope === scope ? rec : null;
  }

  /**
   * نسخه‌ای که تغییر وضعیت بعدی این سفارش باید با آن فرستاده شود:
   * نسخه‌ی دیده‌شده‌ی سرور + تعداد تغییرات وضعیت همین سفارش که هنوز در صف‌اند.
   * سفارشی که هنوز روی سرور نیست نسخه‌ی ۱ دارد (ستون version پیش‌فرض ۱ است).
   */
  async function expectedStatusVersion(orderId, baseVersion) {
    const path = `/orders/${orderId}/status`;
    const queued = (await pendingOps()).filter((o) => o.path === path).length;
    return (baseVersion || 1) + queued;
  }

  /** فهرست ردشده‌ها (فقط برای نشست فعلی) */
  async function rejectedOps() {
    if (!scope) return [];
    return (await all("rejected")).filter((o) => o.scope === scope)
      .sort((a, b) => a.rejectedAt - b.rejectedAt);
  }

  /**
   * بازگرداندن یک عملیات ردشده به صف؛ شناسه حفظ می‌شود، پس تکرار ایمن است.
   * bodyPatch (اختیاری) فیلدهای بدنه را به‌روز می‌کند، مثلاً نسخه‌ی تازه‌ی سفارش پس از بررسی.
   */
  async function retryRejected(opId, bodyPatch) {
    const rec = await get("rejected", opId);
    if (!rec || rec.scope !== scope || rec.unreadable) return false;
    const { reason, rejectedAt, code, ...op } = rec;
    if (bodyPatch) op.body = { ...op.body, ...bodyPatch };
    op.createdAt = Date.now();
    op.order = nextOrder();
    await put("queue", op);
    await del("rejected", opId);
    return true;
  }

  /** حذف دائمی یک عملیات ردشده به درخواست صریح کاربر */
  async function discardRejected(opId) {
    const rec = await get("rejected", opId);
    if (!rec || rec.scope !== scope) return false;
    await del("rejected", opId);
    return true;
  }

  // ارسال صف یک کاربر به ترتیب. نتیجه: {sent, rejected, auth, offline, retry, loggedOut}
  // با نخستین خطای موقت یا ۴۰۱ متوقف می‌شود تا ترتیب وابستگی‌ها حفظ شود.
  async function flushOps(uid) {
    const result = { sent: 0, rejected: 0, auth: false, offline: false, retry: false, loggedOut: false, unreadable: false };
    const ops = (await all("queue")).filter((o) => o.scope === uid).sort((x, y) => x.order - y.order);
    // یک عملیات قابل‌خواندن‌نیست: ترتیب صف شکسته می‌شود، پس کل صف دست‌نخورده و متوقف می‌ماند
    if (ops.some((o) => o.unreadable)) { result.unreadable = true; return result; }
    for (const op of ops) {
      const isLogout = op.path === LOGOUT_PATH;
      try {
        await root.Api.call(op.method, op.path, op.body);
        await del("queue", op.opId);
        result.sent += 1;
        if (isLogout) result.loggedOut = true;
      } catch (err) {
        if (isNetworkError(err)) { result.offline = true; break; }
        if (isLogout) {
          // خروج: اگر نشست از قبل نامعتبر باشد، خروج عملاً انجام شده است؛ هرگز ردشده نمی‌شود
          if (err.status === 401) { result.auth = true; break; }
          if (isPermanent(err)) { await del("queue", op.opId); result.loggedOut = true; continue; }
          result.retry = true; break;
        }
        if (err && err.status === 401) { result.auth = true; break; }
        if (isAlreadyGone(op, err)) {
          await del("queue", op.opId);
          result.sent += 1;
          continue;
        }
        if (isPermanent(err)) {
          await reject(op, err.message || "خطا", err.code);
          result.rejected += 1;
          continue;
        }
        // خطای موقت سرور: صف دست‌نخورده می‌ماند و بعداً دوباره ارسال می‌شود
        result.retry = true;
        break;
      }
    }
    return result;
  }

  // هر کاربر یک ارسال فعال دارد؛ ارسال‌های همان کاربر یکی پس از دیگری اجرا می‌شوند
  let flushing = null;
  let flushingUid = null;
  function runFlush(uid) {
    if (flushing && flushingUid === uid) return flushing;
    const prev = flushing;
    const run = (async () => {
      if (prev) await prev.catch(() => {});
      return flushOps(uid);
    })();
    flushing = run;
    flushingUid = uid;
    run.finally(() => { if (flushing === run) { flushing = null; flushingUid = null; } });
    return run;
  }

  function flush() {
    if (!scope) return Promise.resolve({ sent: 0, rejected: 0, auth: false, offline: false, retry: false, loggedOut: false });
    return runFlush(scope);
  }

  /* ---------- خروج ---------- */

  /**
   * درخواست خروج: خروج به صف اضافه می‌شود تا بعد از همه‌ی تغییرات کاربر ارسال شود.
   * ثبت «در حال خروج» برای این کاربر باقی می‌ماند تا خروج روی سرور تأیید شود.
   */
  async function requestLogout() {
    if (!scope) return false;
    await put("cache", { key: "logout:" + scope, userId: scope, at: Date.now() });
    const queued = (await pendingOps()).some((o) => o.path === LOGOUT_PATH);
    if (!queued) {
      const op = { opId: uuid(), scope, method: "POST", path: LOGOUT_PATH, body: {}, createdAt: Date.now(), order: nextOrder() };
      await put("queue", op);
    }
    return true;
  }

  async function hasPendingLogout(userId) {
    return Boolean(await get("cache", "logout:" + userId));
  }

  /**
   * بعد از ارسال صف یک کاربر: اگر خروج تأیید شده یا نشست از قبل نامعتبر باشد، ثبت خروج پاک می‌شود.
   * کش نمایشی همان کاربر همیشه حذف می‌شود؛ صف و فهرست ردشده (داده‌ی ارسال‌نشده) حفظ می‌شوند.
   */
  async function settleLogout(userId, result) {
    // ثبت خروج بدون عملیات خروج در صف یعنی خروج قبلاً ارسال شده و تسویه‌اش کامل نشده است
    const stillQueued = (await all("queue")).some((o) => o.scope === userId && o.path === LOGOUT_PATH);
    const finished = Boolean((result && (result.loggedOut || result.auth)) || !stillQueued);
    if (finished) {
      for (const op of (await all("queue")).filter((o) => o.scope === userId && o.path === LOGOUT_PATH)) {
        await del("queue", op.opId);
      }
      await del("cache", "logout:" + userId);
    }
    await del("cache", "snapshot:" + userId);
    const last = await get("cache", "last");
    if (last && last.userId === userId) await del("cache", "last");
    return { finished };
  }

  /**
   * خروج‌های نیمه‌تمام همه‌ی کاربران روی این دستگاه را کامل می‌کند (با نشست قدیمی همان کاربر).
   * scope سراسری را تغییر نمی‌دهد مگر برای ارسال همان کاربر.
   */
  async function finishPendingLogouts() {
    const records = (await all("cache")).filter((r) => typeof r.key === "string" && r.key.startsWith("logout:"));
    const outcome = [];
    for (const rec of records) {
      const r = await runFlush(rec.userId);
      outcome.push({ userId: rec.userId, ...(await settleLogout(rec.userId, r)) });
    }
    return outcome;
  }

  // بوت آفلاین: نشانه‌ی کاربر آخرین نشست را فقط در حافظه تنظیم می‌کند (نشانه‌ی ذخیره‌شده تغییر نمی‌کند)
  function restoreScope(userId) { scope = userId || null; }

  /* ---------- کش ---------- */

  // کش فقط برای نمایش آفلاین است؛ خطای قفل داده نباید بارگذاری داده‌ی تازه از سرور را خراب کند
  async function saveCache(snapshot) {
    if (!scope) return;
    try {
      await put("cache", { key: "snapshot:" + scope, data: snapshot, savedAt: Date.now() });
    } catch (err) {
      if (!isLocalDataError(err)) throw err;
    }
  }

  async function loadCache() {
    if (!scope) return null;
    const rec = await get("cache", "snapshot:" + scope);
    return rec && !rec.unreadable ? rec.data : null;
  }

  /* ---------- نمایش داده‌ی در صف ---------- */

  // تاریخ امروز به وقت محلی (ISO)
  function todayIso(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * اعمال تغییرات در صف روی داده‌ی سرور (فقط برای نمایش؛ منبع حقیقت سرور است).
   * raw: {customers, orders, staff, transactions, settings} به شکل پاسخ API
   */
  function applyPending(raw, allOps) {
    const ops = allOps.filter((o) => !o.unreadable);
    const out = {
      customers: [...(raw.customers || [])],
      orders: [...(raw.orders || [])],
      staff: [...(raw.staff || [])],
      transactions: [...(raw.transactions || [])],
      settings: { ...(raw.settings || {}) },
    };
    for (const op of ops) {
      const { method, path, body } = op;
      let m;
      if (method === "POST" && path === "/customers") {
        out.customers.unshift({ id: body.id, name: body.name, phone: body.phone || "", note: body.note || "",
          tier: body.tier || "regular", order_count: 0, _pending: true });
      } else if (method === "POST" && path === "/orders") {
        const cust = out.customers.find((c) => c.id === body.customer_id);
        out.orders.unshift({ id: body.id, order_no: 0, customer_id: body.customer_id,
          customer_name: cust ? cust.name : "", type: body.type, description: body.description,
          status: body.status || "waiting", price: body.price || 0, created_on: todayIso(op.createdAt),
          due_on: body.due_on || null, _pending: true });
      } else if (method === "POST" && (m = path.match(/^\/orders\/([^/]+)\/status$/))) {
        const o = out.orders.find((x) => x.id === m[1]);
        if (o) o.status = body.to;
      } else if (method === "POST" && path === "/staff") {
        out.staff.unshift({ id: body.id, name: body.name, role_title: body.role_title || "",
          phone: body.phone || "", active: true, _pending: true });
      } else if (method === "PATCH" && (m = path.match(/^\/staff\/([^/]+)$/))) {
        const s = out.staff.find((x) => x.id === m[1]);
        if (s) Object.assign(s, body);
      } else if (method === "POST" && path === "/transactions") {
        out.transactions.unshift({ id: body.id, kind: body.kind, category: body.category, amount: body.amount,
          occurred_on: body.occurred_on || todayIso(op.createdAt), note: body.note || "", _pending: true });
      } else if (method === "DELETE" && (m = path.match(/^\/transactions\/([^/]+)$/))) {
        out.transactions = out.transactions.filter((t) => t.id !== m[1]);
      } else if (method === "PUT" && path === "/settings") {
        Object.assign(out.settings, body);
      }
    }
    return out;
  }

  // تأخیر تلاش مجدد: ۳۰ ثانیه، دو برابر در هر شکست، سقف ۵ دقیقه.
  // attempt از ۰ شروع می‌شود (اولین تلاش مجدد).
  const RETRY_BASE_MS = 30000;
  const RETRY_MAX_MS = 5 * 60000;
  function retryDelay(attempt) {
    const n = Math.max(0, Math.min(Math.floor(Number(attempt)) || 0, 10));
    return Math.min(RETRY_BASE_MS * 2 ** n, RETRY_MAX_MS);
  }

  // فقط برای آزمون‌ها: دسترسی خام به فروشگاه‌ها و حذف کلید برای شبیه‌سازی از دست رفتن کلید
  const testing = {
    rawAll: (name) => rawAll(name),
    rawPut: (name, rec) => rawPut(name, rec),
    dropDeviceKey: async () => {
      await del("keys", "device");
      deviceKeyCache = null;
    },
    clearDeviceKeyCache: () => { deviceKeyCache = null; },
  };

  root.Sync = {
    uuid, send, flush, isNetworkError, retryDelay, migrateLocalData, localDataStatus, isLocalDataError, LOCKED_MSG,
    testing,
    beginSession, endSession, lastScope, currentUser, restoreScope,
    requestLogout, hasPendingLogout, settleLogout, finishPendingLogouts,
    pendingOps, pendingCount, rejectedOps, rejectedOp, retryRejected, discardRejected, expectedStatusVersion,
    saveCache, loadCache, applyPending,
  };
})(typeof window !== "undefined" ? window : globalThis);
