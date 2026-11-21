/*
 * همگام‌سازی آفلاین دوخت‌یار (حالت سرور).
 * - تغییرات ناموفق از نبود اتصال در صف IndexedDB می‌مانند و به ترتیب ارسال می‌شوند.
 * - آخرین پاسخ موفق سرور کش می‌شود تا در حالت آفلاین نمایش داده شود.
 * - شناسه‌ی ایجاد با UUID روی کلاینت ساخته می‌شود؛ تکرار ارسال ایمن است (سرور همان ردیف را برمی‌گرداند).
 * - پاسخ‌های رد شده (مثلاً اعتبارسنجی) نگه داشته می‌شوند و دوباره ارسال نمی‌شوند.
 */
(function (root) {
  const DB_NAME = "dokhtyar-sync";
  const DB_VERSION = 1;
  const memory = { queue: new Map(), rejected: new Map(), cache: null };
  let dbPromise = null;
  let flushing = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!root.indexedDB) return resolve(null);
      let req;
      try { req = root.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "opId" });
        if (!db.objectStoreNames.contains("rejected")) db.createObjectStore("rejected", { keyPath: "opId" });
        if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  // هر عملیات IndexedDB. نتیجه: {value} یا null اگر IndexedDB در دسترس نباشد (آنگاه حافظه‌ی صفحه استفاده می‌شود)
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

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    const b = new Uint8Array(16);
    root.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const isNetworkError = (err) => err && err.status === 0;

  async function readAll(name, memKey) {
    const r = await store(name, "readonly", (s) => s.getAll());
    if (r) return r.value || [];
    return [...memory[memKey].values()];
  }

  async function pendingOps() {
    const ops = await readAll("queue", "queue");
    return ops.sort((a, b) => a.createdAt - b.createdAt || (a.opId < b.opId ? -1 : 1));
  }

  async function enqueue(method, path, body) {
    const op = { opId: uuid(), method, path, body, createdAt: Date.now() };
    const r = await store("queue", "readwrite", (s) => s.put(op));
    if (!r) memory.queue.set(op.opId, op);
    return op;
  }

  async function removeOp(opId) {
    const r = await store("queue", "readwrite", (s) => s.delete(opId));
    if (!r) memory.queue.delete(opId);
  }

  async function reject(op, reason) {
    const rec = { ...op, reason, rejectedAt: Date.now() };
    const r = await store("rejected", "readwrite", (s) => s.put(rec));
    if (!r) memory.rejected.set(op.opId, rec);
    await removeOp(op.opId);
  }

  /**
   * ارسال یک تغییر. اگر اتصال نباشد در صف می‌ماند و queued=true برمی‌گرداند.
   * خطاهای غیر از نبود اتصال (اعتبارسنجی، دسترسی) به فراخواننده برمی‌گردند.
   */
  async function send(method, path, body) {
    try {
      await root.Api.call(method, path, body);
      return { queued: false };
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      await enqueue(method, path, body);
      return { queued: true };
    }
  }

  /**
   * ارسال صف به ترتیب. نتیجه: {sent, rejected, auth, offline}
   */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const result = { sent: 0, rejected: 0, auth: false, offline: false };
      const ops = await pendingOps();
      for (const op of ops) {
        try {
          await root.Api.call(op.method, op.path, op.body);
          await removeOp(op.opId);
          result.sent += 1;
        } catch (err) {
          if (isNetworkError(err)) { result.offline = true; break; }
          if (err.status === 401) { result.auth = true; break; }
          // حذف یا به‌روزرسانی ردیفی که دیگر وجود ندارد، یعنی همین کار قبلاً انجام شده است
          const alreadyGone = err.status === 404 && (
            op.method === "DELETE" || op.method === "PATCH" || (op.method === "POST" && /\/status$/.test(op.path)));
          if (alreadyGone) {
            await removeOp(op.opId);
            result.sent += 1;
            continue;
          }
          await reject(op, err.message || "خطا");
          result.rejected += 1;
        }
      }
      return result;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function saveCache(snapshot) {
    const rec = { key: "snapshot", data: snapshot, savedAt: Date.now() };
    const r = await store("cache", "readwrite", (s) => s.put(rec));
    if (!r) memory.cache = rec;
  }

  async function loadCache() {
    const r = await store("cache", "readonly", (s) => s.get("snapshot"));
    const rec = r ? r.value : memory.cache;
    return rec ? rec.data : null;
  }

  async function rejectedOps() {
    return readAll("rejected", "rejected");
  }

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
  function applyPending(raw, ops) {
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

  root.Sync = {
    uuid, send, flush, pendingOps, rejectedOps, saveCache, loadCache, applyPending, isNetworkError,
    pendingCount: async () => (await pendingOps()).length,
  };
})(typeof window !== "undefined" ? window : globalThis);
