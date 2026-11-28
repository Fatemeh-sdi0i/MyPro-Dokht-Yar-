/*
 * منطق رابط کاربری دوخت‌یار
 * دو حالت:
 *   - محلی (پیش‌فرض، REMOTE=false): داده‌ها در localStorage همین مرورگر.
 *   - سرور (REMOTE=true): داده‌ها از API خوانده و به API نوشته می‌شوند.
 */

let activeOrderFilter = "all";
let activeTxFilter = "all";
const REMOTE = !!(window.DOKHTYAR_CONFIG && window.DOKHTYAR_CONFIG.remote);

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const pad2 = (n) => String(n).padStart(2, "0");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 2300);
}

function persist() {
  if (REMOTE) return;
  if (!saveState()) toast("ذخیره‌سازی در این مرورگر امکان‌پذیر نیست؛ تغییرات فقط تا بستن صفحه می‌مانند.");
}

const STORE_ERROR_MSG = "ذخیره‌سازی رمزشده ناموفق بود؛ تغییرات فقط تا بستن صفحه می‌مانند.";

function go(page) {
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === page));
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === page));
  window.scrollTo({ top: 0, behavior: "smooth" });
  renderPage(page);
}

function renderPage(page) {
  const renderers = {
    dashboard: renderDashboard,
    orders: renderOrders,
    customers: renderCustomers,
    coworkers: renderStaff,
    finance: renderFinance,
    reports: renderReports,
    settings: renderSettings,
  };
  renderers[page]?.();
}

function renderAll() {
  renderDashboard();
  renderOrders();
  renderCustomers();
  renderStaff();
  renderDeletedRecords();
  renderFinance();
  renderReports();
  renderSettings();
  applyOwnerBinding();
  $("#logoutBtn").hidden = !REMOTE;
  $("#resetBtn").hidden = REMOTE;
  renderImport();
}

/* ---------- ورود و همگام‌سازی با سرور ---------- */

function showGate() { $("#loginGate").hidden = false; }
function hideGate() { $("#loginGate").hidden = true; }

const TIER_LABEL = { regular: "معمولی", active: "فعال", vip: "VIP" };

// تاریخ میلادی ISO → نمایش شمسی با ارقام فارسی
function faDate(iso) {
  if (!iso) return "تعیین نشده";
  return toFaDigits(Jalali.isoToJalaliString(iso));
}

function mapOrder(o) {
  return {
    uuid: o.id,
    version: o.version,
    customer_id: o.customer_id,
    // مشتری حذف‌شده: سفارش دیده می‌شود ولی تا بازگردانی مشتری قابل ویرایش و تغییر وضعیت نیست
    customer_deleted: Boolean(o.customer_deleted),
    id: o._pending ? "در صف همگام‌سازی" : "۱۴۰۵-" + toFaDigits(pad2(o.order_no).padStart(3, "0")),
    customer: o.customer_name,
    type: o.type,
    desc: o.description,
    created: faDate(o.created_on),
    due: o.due_on ? faDate(o.due_on) : "تعیین نشده",
    status: o.status,
    price: o.price,
  };
}

// داده‌ی خام سرور (شکل پاسخ API)
async function fetchRaw() {
  // فهرست حذف‌شده‌ها: نبود اتصال خطا است؛ خطای دیگر (مثلاً ۴۰۳ برای غیرمدیر) یعنی فهرست خالی
  const optional = (p) => p.catch((err) => (Sync.isNetworkError(err) ? Promise.reject(err) : { items: [] }));
  const [cust, ords, staff, txs, settings, deleted, custDel, ordDel, staffDel] = await Promise.all([
    Api.customers(), Api.orders(), Api.staff(), Api.transactions(), Api.settings(),
    optional(Api.deletedTransactions()),
    optional(Api.deletedCustomers()),
    optional(Api.deletedOrders()),
    optional(Api.deletedStaff()),
  ]);
  return {
    customers: cust.items, orders: ords.items, staff: staff.items, transactions: txs.items,
    deletedTransactions: deleted.items, deletedCustomers: custDel.items, deletedOrders: ordDel.items,
    deletedStaff: staffDel.items, settings,
  };
}

let offlineMode = false;

// فقط برای نمایش؛ منبع حقیقت سرور است. در نبود اتصال از کش آخرین پاسخ موفق استفاده می‌شود.
async function loadRemote() {
  let raw;
  try {
    raw = await fetchRaw();
    offlineMode = false;
    await Sync.saveCache(raw);
  } catch (err) {
    if (!Sync.isNetworkError(err)) throw err;
    const cached = await Sync.loadCache();
    if (!cached) throw err;
    raw = cached;
    offlineMode = true;
  }
  applyRaw(Sync.applyPending(raw, await Sync.pendingOps()));
}

function applyRaw(d) {
  const orders = d.orders.map(mapOrder);
  const lastByCustomer = {};
  orders.forEach((o) => {
    const prev = lastByCustomer[o.customer_id];
    if (!prev || o.created > prev) lastByCustomer[o.customer_id] = o.created;
  });
  state.orders = orders;
  state.customers = d.customers.map((c) => ({
    uuid: c.id,
    version: c.version,
    name: c.name,
    phone: toFaDigits(c.phone || ""),
    count: c.order_count,
    last: lastByCustomer[c.id] || "—",
    state: TIER_LABEL[c.tier] || "معمولی",
    note: c.note || "",
  }));
  state.staff = d.staff.map((s) => ({
    id: s.id, version: s.version, name: s.name, role: s.role_title, phone: toFaDigits(s.phone || ""), active: s.active,
  }));
  // حذف‌شده‌ها فقط برای بازگردانی‌اند و در جمع‌ها و فهرست اصلی نیستند
  state.deletedCustomers = (d.deletedCustomers || []).map((c) => ({
    uuid: c.id, version: c.version, name: c.name, phone: toFaDigits(c.phone || ""), deletedAt: faDate(String(c.deleted_at).slice(0, 10)),
  }));
  state.deletedOrders = (d.deletedOrders || []).map((o) => ({
    ...mapOrder(o), deletedAt: faDate(String(o.deleted_at).slice(0, 10)),
  }));
  state.deletedStaff = (d.deletedStaff || []).map((s) => ({
    id: s.id, name: s.name, role: s.role_title, phone: toFaDigits(s.phone || ""), deletedAt: faDate(String(s.deleted_at).slice(0, 10)),
  }));
  state.transactions = d.transactions.map((t) => ({
    id: t.id, date: faDate(t.occurred_on), kind: t.kind, category: t.category, amount: t.amount, note: t.note,
  }));
  state.deletedTransactions = (d.deletedTransactions || []).map((t) => ({
    id: t.id, date: faDate(t.occurred_on), kind: t.kind, category: t.category, amount: t.amount, note: t.note,
  }));
  state.settings = {
    shopName: d.settings.shop_name,
    ownerName: d.settings.owner_name,
    phone: toFaDigits(d.settings.phone || ""),
    address: d.settings.address || "",
    currency: d.settings.currency || "تومان",
  };
}

// ارسال یک تغییر؛ اگر اتصال نباشد در صف می‌ماند. نتیجه: true یعنی در صف است.
// meta عنوان و جزئیات نمایشی تغییر را در صف نگه می‌دارد تا فهرست ردشده‌ها بگوید کدام مورد مشکل داشت.
const w = (method, path, body, meta) => Sync.send(method, path, body, meta).then((r) => r.queued);

// ارسال صف آفلاین به سرور. خطای موقت سرور یا نبود اتصال: با تأخیر فزاینده دوباره تلاش می‌شود.
let retryTimer = null;
let retryAttempt = 0;
async function syncNow() {
  if (!REMOTE) return;
  clearTimeout(retryTimer);
  const r = await Sync.flush();
  if (r.sent || r.rejected || !(r.retry || r.offline)) retryAttempt = 0;
  if (r.auth) {
    showGate();
    toast("نشست شما پایان یافته است. برای ارسال تغییرات آفلاین دوباره وارد شوید.");
    await renderSync();
    return;
  }
  if (r.sent || r.rejected) {
    await loadRemote().catch(() => {});
    renderAll();
  }
  if (r.unreadable) toast(Sync.LOCKED_MSG);
  if (r.rejected) toast(`${toFaDigits(r.rejected)} تغییر پذیرفته نشد؛ در بخش «همگام‌سازی» تنظیمات می‌توانید آن‌ها را ببینید.`);
  else if (r.sent) toast("تغییرات آفلاین همگام شدند.");
  if ((r.retry || r.offline) && (await Sync.pendingCount()) > 0) {
    retryTimer = setTimeout(syncNow, Sync.retryDelay(retryAttempt));
    retryAttempt += 1;
  }
  await renderSync();
}

const OP_LABEL = (op) => {
  const p = op.path;
  if (p === "/customers") return "افزودن مشتری";
  if (p === "/orders") return "ثبت سفارش";
  if (/\/status$/.test(p)) return "تغییر وضعیت سفارش";
  if (p.startsWith("/staff")) return "تغییر همکار";
  if (p.startsWith("/transactions")) return "ثبت یا حذف تراکنش";
  if (p === "/settings") return "ذخیره تنظیمات";
  return "تغییر";
};

// متن کمکی برای هر کد خطای سرور؛ کدهای ناشناخته همان پیام سرور را نشان می‌دهند
const REJECT_HINT = {
  customer_not_found: "مشتری مربوط روی سرور ثبت نشده است.",
  conflict: "این اطلاعات با مورد موجود روی سرور تداخل دارد (مثلاً شماره‌ی تماس تکراری).",
  id_taken: "این شناسه قبلاً برای مزون دیگری استفاده شده است.",
  not_found: "موردی که می‌خواستید تغییر دهید روی سرور پیدا نشد.",
  version_conflict: "همین مورد هم‌زمان روی دستگاه دیگری تغییر کرده است.",
  customer_deleted: "مشتری این سفارش حذف شده است؛ تا بازگردانی مشتری، سفارش قابل تغییر نیست.",
  phone_taken: "این شماره‌ی تماس اکنون برای مشتری دیگری ثبت شده است؛ ابتدا یکی از آن‌ها را تغییر دهید.",
  invalid_phone: "شماره‌ی موبایل معتبر نیست.",
  invalid_date: "تاریخ وارد شده معتبر نیست.",
  forbidden: "این کار فقط برای مدیر مجاز است.",
};
// توضیح کوتاه برای کاربر؛ اگر پیام سرور متفاوت باشد، همراه آن هم نشان داده می‌شود (برای پشتیبانی)
const rejectReason = (op) => {
  const hint = REJECT_HINT[op.code];
  if (!hint) return op.reason || "خطای ناشناخته از سرور";
  return op.reason && op.reason !== hint ? `${hint} (${op.reason})` : hint;
};

// سفارشی که مشتری‌اش ردشده، به آن مشتری وابسته است و با تلاش مجدد هم پذیرفته نمی‌شود
function dependencyNote(op, rejected) {
  if (op.path !== "/orders" || !op.body || !op.body.customer_id) return "";
  const parent = rejected.find((r) => r.path === "/customers" && r.body && r.body.id === op.body.customer_id);
  return parent ? "این سفارش به مشتری ردشده‌ی بالا وابسته است. ابتدا آن مشتری را اصلاح یا حذف کنید." : "";
}

const fmtTime = (ms) => {
  try { return new Date(ms).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }); }
  catch (e) { return ""; }
};

// پنل همگام‌سازی در تنظیمات: تعداد تغییرات در صف و فهرست ردشده‌ها با جزئیات، تلاش مجدد یا حذف
async function renderSync() {
  const panel = $("#syncPanel");
  if (!panel) return;
  panel.hidden = !REMOTE;
  if (!REMOTE) return;
  const pending = await Sync.pendingCount();
  const rejected = await Sync.rejectedOps();
  const local = await Sync.localDataStatus().catch(() => ({ encrypted: false, unreadable: 0, unreadableMine: 0 }));
  $("#syncLocked").hidden = !local.unreadable;
  let lockedText = local.unreadable ? Sync.LOCKED_MSG + " تا رفع مشکل، ارسال متوقف است." : "";
  if (local.unreadable > local.unreadableMine) {
    lockedText += " موارد ناخوانای کاربران دیگر هم هست؛ تا حذف آن‌ها ذخیره‌ی تغییر جدید ممکن نیست.";
  }
  $("#syncLocked").textContent = lockedText;
  $("#syncDeleteUnreadable").hidden = !local.unreadableMine;
  $("#syncEncryption").textContent = local.encrypted
    ? "داده‌های همگام‌نشده‌ی این مرورگر با کلید غیرقابل استخراج همین دستگاه رمزنگاری می‌شوند."
    : "رمزنگاری در این مرورگر در دسترس نیست؛ داده‌های همگام‌نشده ساده ذخیره می‌شوند.";
  $("#syncPending").textContent = pending
    ? `${toFaDigits(pending)} تغییر هنوز به سرور نرسیده است.`
    : "همه‌ی تغییرات همگام شده‌اند.";
  $("#rejectedBox").hidden = rejected.length === 0;
  $("#rejectedCount").textContent = `${toFaDigits(rejected.length)} مورد نیاز به بررسی دارد.`;
  const list = $("#rejectedList");
  list.textContent = "";
  for (const op of rejected) {
    const li = document.createElement("li");
    li.className = "rejected-item";

    const title = document.createElement("strong");
    title.textContent = op.unreadable ? "مورد قابل خواندن نیست" : ((op.meta && op.meta.title) || OP_LABEL(op));

    const kind = document.createElement("span");
    kind.className = "muted";
    kind.textContent = [OP_LABEL(op), op.rejectedAt ? fmtTime(op.rejectedAt) : ""].filter(Boolean).join(" · ");

    const parts = [title, kind];
    if (op.meta && op.meta.detail) {
      const detail = document.createElement("span");
      detail.className = "muted";
      detail.textContent = op.meta.detail;
      parts.push(detail);
    }

    const reason = document.createElement("p");
    reason.className = "rejected-reason";
    reason.textContent = op.unreadable ? "دلیل: این مورد با کلید این دستگاه باز نمی‌شود." : "دلیل: " + rejectReason(op);
    parts.push(reason);

    const dep = dependencyNote(op, rejected);
    if (dep) {
      const note = document.createElement("p");
      note.className = "rejected-dep";
      note.textContent = dep;
      parts.push(note);
    }

    const actions = document.createElement("div");
    actions.className = "rejected-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "secondary-btn";
    retry.dataset.action = "retry";
    retry.dataset.opId = op.opId;
    retry.textContent = op.code === "version_conflict" ? "بررسی و تلاش مجدد" : "تلاش مجدد";
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "secondary-btn danger";
    drop.dataset.action = "discard";
    drop.dataset.opId = op.opId;
    drop.textContent = "حذف";
    actions.append(...(op.unreadable ? [drop] : [retry, drop]));

    li.append(...parts, actions);
    list.append(li);
  }
}

// تعارض وضعیت: وضعیت فعلی سرور را می‌خوانیم و فقط با تأیید صریح کاربر نسخه‌ی تازه را می‌فرستیم
async function resolveStatusConflict(rec) {
  const orderId = rec.path.split("/")[2];
  const target = rec.body.to;
  let current;
  try {
    current = await Api.call("GET", `/orders/${orderId}`);
  } catch (err) {
    toast(Sync.isNetworkError(err) ? "برای بررسی وضعیت فعلی به اینترنت وصل شوید." : "این سفارش روی سرور پیدا نشد.");
    return;
  }
  if (current.status === target) {
    await Sync.discardRejected(rec.opId);
    toast("این وضعیت از قبل روی سرور ثبت شده است.");
    await renderSync();
    return;
  }
  if (!confirm(`وضعیت فعلی این سفارش روی سرور «${ORDER_STATUS[current.status]}» است. با تأیید، وضعیت به «${ORDER_STATUS[target]}» تغییر می‌کند. ادامه می‌دهید؟`)) return;
  await Sync.retryRejected(rec.opId, { version: current.version });
  syncNow();
}

// حذف موارد ناخوانای همین کاربر؛ دو تأیید، فقط برای ردیف‌های ناخوانا
async function deleteMyUnreadable() {
  if (!confirm("هشدار: موارد همگام‌نشده‌ی ناخوانای حساب شما (تغییرات صف، ردشده‌ها و کش) برای همیشه حذف می‌شوند و قابل بازیابی نیستند. موارد قابل‌خواندن و داده‌ی کاربران دیگر حذف نمی‌شوند. ادامه می‌دهید؟")) return;
  const typed = prompt("برای تأیید نهایی، کلمه‌ی «حذف» را دقیقاً وارد کنید:");
  if (typed !== "حذف") { toast("حذف انجام نشد."); return; }
  try {
    const n = await Sync.deleteUnreadable();
    toast(`${toFaDigits(n)} مورد ناخوانا حذف شد.`);
  } catch (err) {
    toast(err.message || "حذف انجام نشد.");
  }
  renderSync();
}

function bindSyncPanel() {
  $("#syncDeleteUnreadable").addEventListener("click", deleteMyUnreadable);
  $("#syncNowBtn")?.addEventListener("click", () => syncNow());
  $("#rejectedList")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "retry") {
      const rec = await Sync.rejectedOp(btn.dataset.opId);
      if (rec && rec.code === "version_conflict") await resolveStatusConflict(rec);
      else { await Sync.retryRejected(btn.dataset.opId); syncNow(); }
      return;
    }
    if (!confirm("این تغییر برای همیشه حذف شود؟ این کار برگشت‌پذیر نیست.")) return;
    await Sync.discardRejected(btn.dataset.opId);
    await renderSync();
  });
}

// اجرای یک عملیات سرور، سپس خواندن دوباره‌ی داده‌ها و رندر.
// action مقدار true برمی‌گرداند اگر تغییر فقط در صف آفلاین ثبت شده باشد.
async function run(action, okMsg, queuedMsg) {
  try {
    const queued = await action();
    await loadRemote();
    renderAll();
    renderSync().catch(() => {});
    if (queued) toast(queuedMsg || "ذخیره شد؛ پس از اتصال به اینترنت همگام می‌شود.");
    else if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    if (err.status === 401) {
      showGate();
      toast("نشست شما پایان یافته است؛ دوباره وارد شوید.");
    } else {
      toast(err.message || "خطا در ارتباط با سرور");
    }
    return false;
  }
}

async function submitLogin(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  $("#loginError").textContent = "";
  try {
    // خروج‌های ناتمام قبلی باید با نشست قدیمی کامل شوند، پیش از اینکه ورود، کوکی را عوض کند
    await Sync.finishPendingLogouts().catch(() => {});
    const session = await Api.login(String(d.get("email")).trim(), String(d.get("password")));
    currentRole = session.user?.role || null;
    await Sync.beginSession(session.user?.id);
    await loadRemote();
    hideGate();
    renderAll();
    e.target.reset();
    syncNow();
  } catch (err) {
    $("#loginError").textContent = err.message || "ورود ناموفق بود";
  }
}

// خروج در صف همان کاربر ثبت می‌شود و بعد از همه‌ی تغییرات او ارسال می‌شود.
// بدون اینترنت، خروج هنگام اتصال بعدی (حتی بدون ورود مجدد) کامل می‌شود.
async function logout() {
  const uid = Sync.currentUser();
  if (!uid) {
    try { await Api.logout(); } catch (err) { /* بدون نشست شناخته‌شده */ }
    location.reload();
    return;
  }
  const pending = await Sync.pendingCount();
  if (pending && !confirm(`${toFaDigits(pending)} تغییر هنوز ارسال نشده است. این تغییرات روی این دستگاه می‌مانند و به محض اتصال ارسال می‌شوند؛ سپس خروج ثبت می‌شود. ادامه می‌دهید؟`)) return;
  try {
    await Sync.requestLogout();
    const r = await Sync.flush();
    await Sync.settleLogout(uid, r);
  } catch (err) {
    // داده‌ی محلی قابل خواندن نیست: خروج در صف ثبت نمی‌شود؛ اگر اینترنت هست خروج مستقیم انجام می‌شود
    if (!Sync.isLocalDataError(err)) throw err;
    if (navigator.onLine) {
      try { await Api.logout(); } catch (e) { /* نشست از قبل نامعتبر */ }
    }
    toast(Sync.LOCKED_MSG);
  }
  location.reload();
}

/* ---------- حذف نرم در حالت محلی ----------
   در حالت محلی رکوردها حذف فیزیکی نمی‌شوند؛ فیلد deletedAt تنظیم می‌شود و بازگردانی آن را پاک می‌کند.
   نبود این فیلد یعنی رکورد فعال است، پس داده‌های قدیمی و پشتیبان‌های قبلی بدون تغییر کار می‌کنند.
   سفارش‌ها در حالت محلی با نام مشتری به او وصل‌اند؛ مشتری حذف‌شده وقتی است که همه‌ی رکوردهای آن نام حذف‌شده باشند. */
function liveOrders() { return state.orders.filter((o) => !o.deletedAt); }
function liveCustomers() { return state.customers.filter((c) => !c.deletedAt); }
function liveStaff() { return state.staff.filter((s) => !s.deletedAt); }

function localCustomerDeleted(name) {
  const same = state.customers.filter((c) => c.name === name);
  return same.length > 0 && same.every((c) => c.deletedAt);
}

// سفارش قفل است (فقط نمایش و بدون تغییر وضعیت) وقتی مشتری‌اش حذف شده باشد
function isOrderLocked(o) {
  return REMOTE ? Boolean(o.customer_deleted) : localCustomerDeleted(o.customer);
}

/* ---------- داشبورد ---------- */

function countByStatus(status) {
  return liveOrders().filter((o) => o.status === status).length;
}

function deliveredRevenue() {
  return liveOrders().filter((o) => o.status === "delivered").reduce((sum, o) => sum + (Number(o.price) || 0), 0);
}

// درآمد تحویل‌شده به تفکیک ماه شمسی تحویل (تاریخ تحویل). سفارش بدون تاریخ تحویل فقط در مجموع است.
function monthlyRevenue(year) {
  const byMonth = Array(13).fill(0);
  for (const o of liveOrders()) {
    if (o.status !== "delivered") continue;
    const parts = toEnDigits(o.due || "").split("/");
    if (parts.length !== 3 || parseInt(parts[0], 10) !== year) continue;
    const m = parseInt(parts[1], 10);
    if (m >= 1 && m <= 12) byMonth[m] += Number(o.price) || 0;
  }
  return byMonth;
}

function renderMonthlyChart() {
  const year = parseInt(toEnDigits(TODAY_JALALI).split("/")[0], 10);
  const currentMonth = parseInt(toEnDigits(TODAY_JALALI).split("/")[1], 10);
  const all = monthlyRevenue(year);
  const range = $("#monthlyRange").value === "half" ? Array.from({ length: 6 }, (_, i) => currentMonth - 5 + i).filter((m) => m >= 1) : Array.from({ length: 12 }, (_, i) => i + 1);
  const values = range.map((m) => all[m]);
  const max = Math.max(1, ...values);
  const W = 700, H = 190, pad = 16;
  const pts = values.map((v, i) => {
    const x = range.length > 1 ? (i * W) / (range.length - 1) : W / 2;
    const y = H - pad - (v / max) * (H - pad * 2);
    return { x: x.toFixed(1), y: y.toFixed(1) };
  });
  const line = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const area = `M0 ${H} L${pts.map((p) => `${p.x} ${p.y}`).join(" L")} L${W} ${H}Z`;
  $("#monthlyChart").innerHTML = `<defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f1d6bd" stop-opacity=".3"/><stop offset="1" stop-color="#f1d6bd" stop-opacity="0"/></linearGradient></defs>`
    + `<path d="${area}" fill="url(#area)"/><polyline points="${line}" fill="none" stroke="#f4dfcc" stroke-width="3"/>`
    + `<g fill="#fff0df" stroke="#fff" stroke-width="2">${pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="4"/>`).join("")}</g>`;
  $("#monthlyLabels").innerHTML = range.map((m) => `<span>${esc(PERSIAN_MONTHS[m - 1])}</span>`).join("");
  const total = values.reduce((a, b) => a + b, 0);
  const undated = liveOrders().some((o) => o.status === "delivered" && !(parseInt(toEnDigits(o.due || "").split("/")[0], 10) === year));
  const note = $("#monthlyNote");
  note.hidden = !(total === 0 || undated);
  note.textContent = total === 0
    ? "هنوز درآمدی با تاریخ تحویل در این بازه ثبت نشده است."
    : "سفارش‌های تحویل‌شده‌ای که تاریخ تحویل ندارند یا در سال جاری نیستند، در نمودار نمی‌آیند؛ در مجموع درآمد هستند.";
}

function renderDashboard() {
  renderMonthlyChart();
  $("#statDelivered").textContent = toFaDigits(countByStatus("delivered"));
  $("#statReady").textContent = toFaDigits(countByStatus("ready"));
  $("#statProgress").textContent = toFaDigits(countByStatus("progress"));
  $("#statWaiting").textContent = toFaDigits(countByStatus("waiting"));
  $("#revenueTotal").textContent = formatMoney(deliveredRevenue());
  renderUpcoming();
}

function dueLabel(due) {
  const parts = toEnDigits(due).split("/");
  if (parts.length !== 3) return esc(due);
  return esc(toFaDigits(parseInt(parts[2], 10))) + " " + jalaliMonthName(due);
}

function renderUpcoming() {
  const rows = liveOrders()
    .filter((o) => o.status !== "delivered")
    .slice(0, 3)
    .map(
      (o) => `<div class="upcoming-row">
        <span class="mini-avatar">${esc(o.customer[0])}</span>
        <div class="who"><b>${esc(o.customer)} – ${esc(o.desc)}</b><small>${ORDER_STATUS[o.status]}</small></div>
        <span class="date-pill">${dueLabel(o.due)}</span>
      </div>`
    );
  $("#upcomingList").innerHTML = rows.join("") || '<div class="detail-empty">سفارش فعالی وجود ندارد.</div>';
}

/* ---------- سفارش‌ها ---------- */

function matchesOrderFilter(order) {
  if (activeOrderFilter === "all") return true;
  if (activeOrderFilter === "sewing" || activeOrderFilter === "repair") return order.type === activeOrderFilter;
  return order.status === activeOrderFilter;
}

function renderOrders() {
  const q = ($("#orderSearch")?.value || "").trim().toLowerCase();
  const status = $('input[name="status"]:checked')?.value || "all";
  const kinds = $$('input[name="kind"]:checked').map((x) => x.value);

  const filtered = liveOrders().filter(
    (o) =>
      matchesOrderFilter(o) &&
      (status === "all" || o.status === status) &&
      kinds.includes(o.type) &&
      (!q || [o.id, o.customer, o.desc].join(" ").toLowerCase().includes(q))
  );

  $("#ordersBody").innerHTML =
    filtered
      .map((o) => {
        const idx = state.orders.indexOf(o);
        return `<tr>
          <td><span class="order-thumb">${o.type === "repair" ? "✂" : "♟"}</span></td>
          <td>${esc(o.id)}</td>
          <td>${ORDER_TYPE[o.type] ?? ""}</td>
          <td>${esc(o.customer)}</td>
          <td>${esc(o.created)}</td>
          <td>${esc(o.due)}</td>
          <td><span class="status ${o.status}">${ORDER_STATUS[o.status]}</span></td>
          <td>${isOrderLocked(o)
            ? '<span class="muted" title="تا بازگردانی مشتری قابل ویرایش نیست">مشتری حذف شده</span>'
            : `<button class="dots" title="تغییر وضعیت" data-status-index="${idx}">•••</button> <button class="chip" data-delete-order="${esc(REMOTE ? o.uuid : o.id)}">حذف</button>`}</td>
        </tr>`;
      })
      .join("") || '<tr><td colspan="8">سفارشی با این مشخصات پیدا نشد.</td></tr>';
}

async function changeOrderStatus(idx) {
  const o = state.orders[idx];
  if (!o || o.deletedAt) return;
  if (isOrderLocked(o)) {
    toast("مشتری این سفارش حذف شده است؛ ابتدا مشتری را بازگردانید.");
    return;
  }
  const to = NEXT_STATUS[o.status];
  if (REMOTE) {
    // نسخه‌ی دیده‌شده (با تغییرات وضعیت در صف) همراه تغییر می‌رود؛ اگر سرور جلوتر باشد، ۴۰۹ و بدون بازنویسی
    const version = await Sync.expectedStatusVersion(o.uuid, o.version);
    await run(() => w("POST", `/orders/${o.uuid}/status`, { to, version }, { title: `تغییر وضعیت سفارش ${o.customer || ""}`, detail: `به «${ORDER_STATUS[to]}»` }), "وضعیت سفارش به «" + ORDER_STATUS[to] + "» تغییر کرد.");
    return;
  }
  o.status = to;
  persist();
  renderOrders();
  renderDashboard();
  toast("وضعیت سفارش به «" + ORDER_STATUS[to] + "» تغییر کرد.");
}

/* ---------- مشتریان ---------- */

function renderCustomers() {
  const q = ($("#customerSearch")?.value || "").trim();
  const rows = liveCustomers().filter((c) => !q || (c.name + c.phone).includes(q));

  $("#customersBody").innerHTML =
    rows
      .map((c) => {
        const idx = state.customers.indexOf(c);
        const stateClass = c.state === "فعال" ? "delivered" : c.state === "VIP" ? "progress" : "ready";
        return `<tr data-customer="${idx}">
          <td><span class="mini-avatar">${esc(c.name[0])}</span></td>
          <td>${esc(c.name)}</td>
          <td>${esc(c.phone)}</td>
          <td>${toFaDigits(c.count)}</td>
          <td>${esc(c.last)}</td>
          <td><span class="status ${stateClass}">${esc(c.state)}</span></td>
          <td><button class="dots" data-detail="${idx}">•••</button> <button class="chip" data-delete-customer="${esc(REMOTE ? c.uuid : idx)}">حذف</button></td>
        </tr>`;
      })
      .join("") || '<tr><td colspan="7">مشتری پیدا نشد.</td></tr>';

  $("#customerCount").textContent = toFaDigits(liveCustomers().length);
}

function showCustomer(i) {
  const c = state.customers[i];
  if (!c) return;
  $("#customerDetail").innerHTML = `<h3>مشخصات مشتری</h3>
    <div class="customer-profile">
      <div class="avatar">${esc(c.name[0])}</div>
      <h2>${esc(c.name)}</h2>
      <p>☎ ${esc(c.phone)}</p>
    </div>
    <div class="detail-metrics">
      <div>تعداد سفارش‌ها<b>${toFaDigits(c.count)}</b></div>
      <div>آخرین سفارش<b>${esc(c.last)}</b></div>
    </div>
    <div class="detail-note">♥ ${esc(c.note) || "یادداشتی برای این مشتری ثبت نشده است."}</div>`;
}

/* ---------- همکاران ---------- */

function renderStaff() {
  const live = liveStaff();
  const active = live.filter((s) => s.active).length;
  $("#staffCount").textContent = toFaDigits(live.length);
  $("#staffActive").textContent = toFaDigits(active);
  $("#staffBody").innerHTML =
    live
      .map(
        (s) => `<tr>
          <td><span class="mini-avatar">${esc(s.name[0])}</span></td>
          <td>${esc(s.name)}</td>
          <td>${esc(s.role)}</td>
          <td>${esc(s.phone)}</td>
          <td><span class="status ${s.active ? "delivered" : "waiting"}">${s.active ? "فعال" : "غیرفعال"}</span></td>
          <td><button class="chip" data-toggle-staff="${esc(s.id)}">${s.active ? "غیرفعال کردن" : "فعال کردن"}</button> <button class="chip" data-delete-staff="${esc(s.id)}">حذف</button></td>
        </tr>`
      )
      .join("") || '<tr><td colspan="6">همکاری ثبت نشده است.</td></tr>';
}

async function toggleStaff(id) {
  const s = state.staff.find((x) => String(x.id) === String(id));
  if (!s) return;
  if (REMOTE) {
    await run(() => w("PATCH", `/staff/${s.id}`, { active: !s.active }, { title: `همکار: ${s.name}`, detail: s.active ? "غیرفعال کردن" : "فعال کردن" }), s.active ? "همکار غیرفعال شد." : "همکار فعال شد.");
    return;
  }
  s.active = !s.active;
  persist();
  renderStaff();
  toast(s.active ? "همکار فعال شد." : "همکار غیرفعال شد.");
}

/* ---------- امور مالی ---------- */

// تراکنش‌های حذف‌شده (حذف نرم) در جمع‌ها و فهرست اصلی نیستند؛ فقط در بخش بازگردانی دیده می‌شوند
function liveTransactions() {
  return state.transactions.filter((t) => !t.deletedAt);
}

function renderFinance() {
  const live = liveTransactions();
  const manualIncome = live.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0);
  const expense = live.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0);
  const orderIncome = deliveredRevenue();
  const balance = orderIncome + manualIncome - expense;

  $("#finOrderIncome").textContent = formatMoney(orderIncome);
  $("#finOtherIncome").textContent = formatMoney(manualIncome);
  $("#finExpense").textContent = formatMoney(expense);
  $("#finBalance").textContent = formatMoney(balance);

  const filtered = live.filter((t) => activeTxFilter === "all" || t.kind === activeTxFilter);
  // محلی: جدیدترین اول (آخرین افزوده‌شده‌ها در انتها هستند)؛ سرور از قبل مرتب است
  const rows = REMOTE ? filtered : filtered.slice().reverse();

  $("#txBody").innerHTML =
    rows
      .map(
        (t) => `<tr>
          <td>${esc(t.date)}</td>
          <td><span class="status ${t.kind === "income" ? "delivered" : "ready"}">${t.kind === "income" ? "درآمد" : "هزینه"}</span></td>
          <td>${esc(t.category)}</td>
          <td>${esc(t.note) || "—"}</td>
          <td>${formatMoney(t.amount)}</td>
          <td><button class="chip" data-delete-tx="${esc(t.id)}">حذف</button></td>
        </tr>`
      )
      .join("") || '<tr><td colspan="6">تراکنشی برای نمایش وجود ندارد.</td></tr>';
  renderDeletedTransactions();
}

function renderDeletedTransactions() {
  const rows = REMOTE
    ? (state.deletedTransactions || [])
    : state.transactions.filter((t) => t.deletedAt).slice().reverse();
  $("#txDeletedWrap").hidden = rows.length === 0;
  $("#txDeletedCount").textContent = toFaDigits(String(rows.length));
  $("#txDeletedBody").innerHTML = rows
    .map(
      (t) => `<tr>
          <td>${esc(t.date)}</td>
          <td><span class="status ${t.kind === "income" ? "delivered" : "ready"}">${t.kind === "income" ? "درآمد" : "هزینه"}</span></td>
          <td>${esc(t.category)}</td>
          <td>${esc(t.note) || "—"}</td>
          <td>${formatMoney(t.amount)}</td>
          <td><button class="chip" data-restore-tx="${esc(t.id)}">بازگردانی</button></td>
        </tr>`
    )
    .join("");
}

/* ---------- حذف و بازگردانی مشتری، سفارش و همکار ----------
   حالت محلی: حذف نرم در همین مرورگر (بدون اتصال).
   حالت سرور: مستقیم به سرور می‌روند و در صف آفلاین نمی‌مانند؛ بدون اتصال انجام نمی‌شوند. */

// حذف‌شده‌های حالت محلی به همان شکل فهرست سرور تبدیل می‌شوند تا قالب‌های بازگردانی یکی بمانند
function localDeletedRecords() {
  const day = (iso) => faDate(String(iso).slice(0, 10));
  const newestFirst = (arr) => arr.slice().reverse();
  return {
    customers: newestFirst(state.customers.map((c, i) => ({ c, i })).filter((x) => x.c.deletedAt)).map(({ c, i }) => ({
      uuid: String(i), name: c.name, phone: c.phone, deletedAt: day(c.deletedAt),
    })),
    orders: newestFirst(state.orders.filter((o) => o.deletedAt)).map((o) => ({
      uuid: o.id, id: o.id, customer: o.customer, type: o.type, deletedAt: day(o.deletedAt),
    })),
    staff: newestFirst(state.staff.filter((s) => s.deletedAt)).map((s) => ({
      id: s.id, name: s.name, role: s.role, deletedAt: day(s.deletedAt),
    })),
  };
}

function renderDeletedRecords() {
  const local = REMOTE ? null : localDeletedRecords();
  const show = (wrap, count, body, rows, rowHtml) => {
    $(wrap).hidden = rows.length === 0;
    $(count).textContent = toFaDigits(String(rows.length));
    $(body).innerHTML = rows.map(rowHtml).join("");
  };
  show("#custDeletedWrap", "#custDeletedCount", "#custDeletedBody", REMOTE ? state.deletedCustomers || [] : local.customers,
    (c) => `<tr>
          <td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.deletedAt)}</td>
          <td><button class="chip" data-restore-customer="${esc(c.uuid)}">بازگردانی</button></td>
        </tr>`);
  show("#orderDeletedWrap", "#orderDeletedCount", "#orderDeletedBody", REMOTE ? state.deletedOrders || [] : local.orders,
    (o) => `<tr>
          <td>${esc(o.id)}</td><td>${esc(o.customer)}</td><td>${ORDER_TYPE[o.type] ?? ""}</td><td>${esc(o.deletedAt)}</td>
          <td><button class="chip" data-restore-order="${esc(o.uuid)}">بازگردانی</button></td>
        </tr>`);
  show("#staffDeletedWrap", "#staffDeletedCount", "#staffDeletedBody", REMOTE ? state.deletedStaff || [] : local.staff,
    (s) => `<tr>
          <td>${esc(s.name)}</td><td>${esc(s.role)}</td><td>${esc(s.deletedAt)}</td>
          <td><button class="chip" data-restore-staff="${esc(s.id)}">بازگردانی</button></td>
        </tr>`);
}

function requireOnline(action) {
  if (offlineMode) {
    toast(`برای ${action} به اینترنت وصل باشید.`);
    return false;
  }
  return true;
}

// اجرای مستقیم یک عملیات سرور؛ پیام خطا همان متن فارسی سرور است
async function runDirect(action, okMsg) {
  try {
    await action();
    await loadRemote();
    renderAll();
    toast(okMsg);
  } catch (err) {
    if (err.status === 401) {
      showGate();
      toast("نشست شما پایان یافته است؛ دوباره وارد شوید.");
    } else if (Sync.isNetworkError(err)) {
      toast("اتصال به سرور برقرار نشد؛ این عملیات انجام نشد.");
    } else {
      toast(err.message || "عملیات انجام نشد.");
    }
  }
}

// حالت محلی: حذف و بازگردانی نرم و بدون اتصال. تغییر فقط در همین مرورگر ذخیره می‌شود.
function setLocalDeleted(record, deleted) {
  record.deletedAt = deleted ? new Date().toISOString() : null;
  persist();
  renderAll();
}

async function deleteCustomerRecord(id) {
  if (!REMOTE) {
    const c = state.customers[Number(id)];
    if (!c || c.deletedAt) return;
    // اگر مشتری فعال دیگری با همین نام باشد، سفارش‌ها به کدام یک تعلق دارند معلوم نیست؛ حذف انجام نمی‌شود
    if (state.customers.some((x) => x !== c && x.name === c.name && !x.deletedAt)) {
      return toast("چند مشتری فعال با این نام وجود دارد؛ حذف انجام نشد تا سفارش‌ها به اشتباه قفل نشوند.");
    }
    if (!confirm(`مشتری «${c.name}» حذف شود؟ سفارش‌هایش حذف نمی‌شوند و از بخش «حذف‌شده‌ها» بازگردانی می‌شود.`)) return;
    setLocalDeleted(c, true);
    toast("مشتری حذف شد. از بخش «حذف‌شده‌ها» می‌توانید بازگردانید.");
    return;
  }
  const c = state.customers.find((x) => x.uuid === id);
  if (!c || !requireOnline("حذف مشتری")) return;
  if (!confirm(`مشتری «${c.name}» حذف شود؟ سفارش‌هایش حذف نمی‌شوند و از بخش «حذف‌شده‌ها» بازگردانی می‌شود.`)) return;
  await runDirect(() => Api.deleteCustomer(id, c.version), "مشتری حذف شد.");
}

async function deleteOrderRecord(id) {
  if (!REMOTE) {
    const o = state.orders.find((x) => x.id === id);
    if (!o || o.deletedAt) return;
    if (isOrderLocked(o)) return toast("مشتری این سفارش حذف شده است؛ ابتدا مشتری را بازگردانید.");
    if (!confirm("این سفارش حذف شود؟ از بخش «سفارش‌های حذف‌شده» بازگردانی می‌شود.")) return;
    setLocalDeleted(o, true);
    toast("سفارش حذف شد. از بخش «سفارش‌های حذف‌شده» می‌توانید بازگردانید.");
    return;
  }
  const o = state.orders.find((x) => x.uuid === id);
  if (!o || !requireOnline("حذف سفارش")) return;
  if (!confirm("این سفارش حذف شود؟ از بخش «سفارش‌های حذف‌شده» بازگردانی می‌شود.")) return;
  await runDirect(() => Api.deleteOrder(id, o.version), "سفارش حذف شد.");
}

async function deleteStaffRecord(id) {
  if (!REMOTE) {
    const s = state.staff.find((x) => String(x.id) === String(id));
    if (!s || s.deletedAt) return;
    if (!confirm(`همکار «${s.name}» حذف شود؟ از بخش «حذف‌شده‌ها» بازگردانی می‌شود.`)) return;
    setLocalDeleted(s, true);
    toast("همکار حذف شد. از بخش «حذف‌شده‌ها» می‌توانید بازگردانید.");
    return;
  }
  const s = state.staff.find((x) => String(x.id) === String(id));
  if (!s || !requireOnline("حذف همکار")) return;
  if (!confirm(`همکار «${s.name}» حذف شود؟ اگر حساب ورود به او متصل باشد، ورودش مسدود می‌شود.`)) return;
  await runDirect(() => Api.deleteStaff(id, s.version), "همکار حذف شد.");
}

async function restoreRecord(kind, id) {
  if (!REMOTE) {
    // بازگردانی مشتری، سفارش‌هایش را خودکار برنمی‌گرداند؛ سفارش‌ها جدا بازگردانده می‌شوند (مانند سرور)
    const target = kind === "customer" ? state.customers[Number(id)]
      : kind === "order" ? state.orders.find((x) => x.id === id)
      : state.staff.find((x) => String(x.id) === String(id));
    if (!target || !target.deletedAt) return;
    setLocalDeleted(target, false);
    toast({ customer: "مشتری بازگردانده شد.", order: "سفارش بازگردانده شد.", staff: "همکار بازگردانده شد." }[kind]);
    return;
  }
  if (!requireOnline("بازگردانی")) return;
  const actions = {
    customer: [() => Api.restoreCustomer(id), "مشتری بازگردانده شد."],
    order: [() => Api.restoreOrder(id), "سفارش بازگردانده شد."],
    staff: [() => Api.restoreStaff(id), "همکار بازگردانده شد."],
  };
  const [action, okMsg] = actions[kind];
  await runDirect(action, okMsg);
}

// حذف نرم: ردیف نگه داشته می‌شود تا تاریخچه‌ی مالی کامل بماند و بازگردانی ممکن باشد
async function deleteTransaction(id) {
  if (!confirm("این تراکنش حذف شود؟ از بخش «تراکنش‌های حذف‌شده» بازگردانی می‌شود.")) return;
  if (REMOTE) {
    await run(() => w("DELETE", `/transactions/${id}`, undefined, { title: "حذف تراکنش", detail: "" }), "تراکنش حذف شد.");
    return;
  }
  const t = state.transactions.find((x) => String(x.id) === String(id));
  if (!t) return;
  t.deletedAt = new Date().toISOString();
  persist();
  renderFinance();
  renderReports();
  toast("تراکنش حذف شد. از بخش «تراکنش‌های حذف‌شده» می‌توانید بازگردانید.");
}

async function restoreTransaction(id) {
  if (REMOTE) {
    try {
      await Api.restoreTransaction(id);
      await loadRemote();
      renderAll();
      toast("تراکنش بازگردانده شد.");
    } catch (err) {
      if (err.status === 401) { showGate(); toast("نشست شما پایان یافته است؛ دوباره وارد شوید."); }
      else toast(err.message || "بازگردانی تراکنش انجام نشد.");
    }
    return;
  }
  const t = state.transactions.find((x) => String(x.id) === String(id));
  if (!t || !t.deletedAt) return;
  t.deletedAt = null;
  persist();
  renderFinance();
  renderReports();
  toast("تراکنش بازگردانده شد.");
}

/* ---------- گزارش‌ها ---------- */

function renderReports() {
  const orders = liveOrders();
  const total = orders.length;
  const delivered = countByStatus("delivered");
  const revenue = deliveredRevenue();
  const avg = delivered ? Math.round(revenue / delivered) : 0;

  const statusBars = Object.keys(ORDER_STATUS)
    .map((k) => {
      const n = countByStatus(k);
      const pct = total ? Math.round((n / total) * 100) : 0;
      return `<div class="bar-row"><span>${ORDER_STATUS[k]}</span><div class="bar"><i style="width:${pct}%"></i></div><b>${toFaDigits(n)}</b></div>`;
    })
    .join("");

  const typeBars = Object.keys(ORDER_TYPE)
    .map((k) => {
      const n = orders.filter((o) => o.type === k).length;
      const pct = total ? Math.round((n / total) * 100) : 0;
      return `<div class="bar-row"><span>${ORDER_TYPE[k]}</span><div class="bar"><i style="width:${pct}%"></i></div><b>${toFaDigits(n)}</b></div>`;
    })
    .join("");

  const counts = {};
  orders.forEach((o) => (counts[o.customer] = (counts[o.customer] || 0) + 1));
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, n]) => `<div class="upcoming-row"><span class="mini-avatar">${esc(name[0])}</span><div class="who"><b>${esc(name)}</b></div><span class="date-pill">${toFaDigits(n)} سفارش</span></div>`)
    .join("");

  $("#reportsContent").innerHTML = `
    <div class="customer-stats">
      <article class="stat-card navy"><label>کل سفارش‌ها</label><strong>${toFaDigits(total)}</strong></article>
      <article class="stat-card cream"><label>تحویل‌شده</label><strong>${toFaDigits(delivered)}</strong></article>
      <article class="stat-card cream"><label>درآمد تحویل‌شده (${esc(state.settings.currency)})</label><strong class="small-num">${formatMoney(revenue)}</strong></article>
      <article class="stat-card navy"><label>میانگین هر سفارش</label><strong class="small-num">${formatMoney(avg)}</strong></article>
    </div>
    <div class="dashboard-grid">
      <section class="panel"><h2 class="panel-title">وضعیت سفارش‌ها</h2>${statusBars}</section>
      <section class="panel"><h2 class="panel-title">نوع سفارش‌ها</h2>${typeBars}</section>
      <section class="panel"><h2 class="panel-title">پرسفارش‌ترین مشتری‌ها</h2>${top || '<div class="detail-empty">داده‌ای نیست.</div>'}</section>
    </div>`;
}

/* ---------- تنظیمات ---------- */

function renderSettings() {
  const form = $("#settingsForm");
  if (!form || document.activeElement?.closest("#settingsForm")) return;
  for (const [k, v] of Object.entries(state.settings)) {
    if (form.elements[k]) form.elements[k].value = v;
  }
}

function applyOwnerBinding() {
  const name = state.settings.ownerName || "مدیر مزون";
  $$('[data-bind="ownerName"]').forEach((el) => (el.textContent = name));
  $$('[data-bind="ownerInitial"]').forEach((el) => (el.textContent = name[0] || "م"));
}

async function submitSettings(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  const phoneRaw = String(d.get("phone") || "").trim();
  if (REMOTE) {
    await run(() => w("PUT", "/settings", {
      shop_name: String(d.get("shopName") || "").trim() || undefined,
      owner_name: String(d.get("ownerName") || "").trim(),
      phone: phoneRaw,
      address: String(d.get("address") || "").trim(),
      currency: String(d.get("currency") || "").trim() || undefined,
    }, { title: "تنظیمات مزون", detail: "" }), "تنظیمات ذخیره شد.");
    return;
  }
  state.settings = {
    shopName: String(d.get("shopName") || "").trim() || SEED.settings.shopName,
    ownerName: String(d.get("ownerName") || "").trim() || SEED.settings.ownerName,
    phone: toFaDigits(phoneRaw),
    address: String(d.get("address") || "").trim(),
    currency: String(d.get("currency") || "").trim() || "تومان",
  };
  persist();
  applyOwnerBinding();
  renderReports();
  toast("تنظیمات ذخیره شد.");
}

// همان داده‌ای که پشتیبان ساده می‌دهد، در هر دو حالت
async function backupPayload() {
  return REMOTE ? Api.exportJson() : state;
}

function downloadText(fileName, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// پشتیبان ساده (بدون تغییر در رفتار)
async function exportData() {
  let payload;
  try { payload = await backupPayload(); }
  catch (err) { toast(err.message || "دانلود پشتیبان انجام نشد"); return; }
  downloadText("dokhtyar-backup.json", JSON.stringify(payload, null, 2));
  noteBackupDone();
}

// زمان آخرین پشتیبان فقط در حالت محلی ثبت و یادآوری می‌شود
function noteBackupDone() {
  if (REMOTE) return;
  LocalStore.markBackupDone();
  renderBackupReminder();
}

function localDateIso(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// یادآور پشتیبان: تاریخ آخرین پشتیبان و هشدار بعد از آستانه (فقط حالت محلی)
function renderBackupReminder() {
  const el = $("#backupReminder");
  if (!el || REMOTE) return;
  const s = LocalStore.backupReminderState();
  let text;
  if (s.lastBackupAt === null) {
    text = "هنوز هیچ پشتیبانی از داده‌های این مرورگر گرفته نشده است. همین حالا یک پشتیبان JSON دانلود کنید.";
  } else {
    const when = faDate(localDateIso(s.lastBackupAt));
    text = s.daysSince === 0
      ? `آخرین پشتیبان: امروز (${when}).`
      : `آخرین پشتیبان: ${when} (${toFaDigits(String(s.daysSince))} روز پیش).`;
    if (s.due) text += ` بیش از ${toFaDigits(String(s.thresholdDays))} روز گذشته است؛ یک پشتیبان تازه بگیرید.`;
  }
  el.textContent = text;
  el.hidden = false;
}

function setBackupMsg(text, isError) {
  const el = $("#backupMsg");
  el.textContent = text;
  el.dataset.state = isError ? "error" : "ok";
}

function backupErrorText(err) {
  if (window.BackupCrypto && err instanceof BackupCrypto.BackupError) return err.message;
  return "عملیات انجام نشد؛ هیچ داده‌ای تغییر نکرد.";
}

// پشتیبان رمزشده (اختیاری). گذرواژه فقط در حافظه‌ی همین صفحه است و ذخیره یا ارسال نمی‌شود.
async function exportEncryptedData() {
  const pw = $("#backupPassword").value;
  const pw2 = $("#backupPassword2").value;
  if (pw !== pw2) return setBackupMsg("گذرواژه و تکرار آن یکی نیستند.", true);
  setBackupMsg("در حال رمزنگاری…", false);
  try {
    const payload = await backupPayload();
    const text = await BackupCrypto.encryptBackup(JSON.stringify(payload, null, 2), pw);
    downloadText("dokhtyar-backup-encrypted.json", text);
    noteBackupDone();
    $("#backupPassword").value = "";
    $("#backupPassword2").value = "";
    setBackupMsg("فایل رمزشده دانلود شد. گذرواژه را جای امنی نگه دارید؛ بدون آن این فایل قابل بازیابی نیست.", false);
  } catch (err) {
    setBackupMsg(backupErrorText(err), true);
  }
}

// آخرین فایلی که با موفقیت بررسی شده؛ بازگردانی فقط همین محتوای بررسی‌شده را استفاده می‌کند (دوباره خوانده نمی‌شود)
let verifiedBackup = null;

function renderRestoreControls() {
  const btn = $("#backupRestoreBtn");
  const note = $("#backupRestoreNote");
  const wanted = REMOTE ? "server" : "local";
  const usable = Boolean(verifiedBackup) && verifiedBackup.kind === wanted;
  const blocked = usable && !REMOTE ? LocalStore.restoreBlockedReason() : null;
  btn.hidden = !usable;
  btn.disabled = Boolean(blocked);
  btn.textContent = REMOTE ? "بازگردانی روی سرور…" : "بازگردانی از این فایل…";
  note.textContent = blocked || "";
  note.hidden = !blocked;
}

// بررسی فایل پشتیبان (ساده یا رمزشده). فقط می‌خواند؛ هیچ‌چیز در داده‌ی برنامه نوشته یا جایگزین نمی‌شود.
async function checkBackupFile() {
  const input = $("#backupCheckFile");
  const file = input.files && input.files[0];
  verifiedBackup = null;
  renderRestoreControls();
  if (!file) return setBackupMsg("ابتدا فایل پشتیبان را انتخاب کنید.", true);
  if (file.size > 50 * 1024 * 1024) return setBackupMsg("فایل بیش از حد بزرگ است.", true);
  setBackupMsg("در حال بررسی…", false);
  try {
    const text = await file.text();
    let r;
    try {
      r = { ...(await BackupCrypto.decryptBackup(text, $("#backupCheckPassword").value)), encrypted: true };
    } catch (err) {
      if (err.code !== "not_encrypted") throw err;
      r = { ...BackupCrypto.parseBackup(text), encrypted: false };
    }
    const c = r.counts;
    const kindText = REMOTE
      ? (r.kind === "server"
        ? "این فایل از پشتیبان همین سرور است و می‌توانید از آن بازگردانی کنید. پیش از بازگردانی، داده‌ی فعلی سرور در نسخه‌ی محافظت‌شده ذخیره می‌شود."
        : "این فایل حالت محلی است و در حالت سرور بازگردانی نمی‌شود.")
      : (r.kind === "server"
        ? "این فایل پشتیبان حالت سرور است و در حالت محلی بازگردانی نمی‌شود."
        : "می‌توانید از همین فایل بازگردانی کنید.");
    setBackupMsg(
      `فایل ${r.encrypted ? "رمزشده" : "ساده"} معتبر است: ${c.customers} مشتری، ${c.orders} سفارش، ${c.staff} همکار، ${c.transactions} تراکنش. ` +
      `هیچ داده‌ای تغییر نکرد. ${kindText}`,
      false,
    );
    verifiedBackup = { kind: r.kind, data: r.data, counts: c };
    renderRestoreControls();
  } catch (err) {
    setBackupMsg(backupErrorText(err), true);
  }
}

// بازگردانی از فایلی که همین حالا بررسی شده. داده‌ی فعلی پیش از آن در پشتیبان محافظت‌شده می‌ماند.
async function restoreVerifiedBackup() {
  if (REMOTE) return restoreOnServer();
  if (!verifiedBackup || verifiedBackup.kind !== "local") return;
  const blocked = LocalStore.restoreBlockedReason();
  if (blocked) return setBackupMsg(blocked, true);
  const c = verifiedBackup.counts;
  if (!confirm(`داده‌ی فعلی با این فایل جایگزین می‌شود (مشتری ${c.customers}، سفارش ${c.orders}). داده‌ی فعلی در پشتیبان محافظت‌شده نگه داشته می‌شود و هیچ‌چیز حذف نمی‌شود. ادامه می‌دهید؟`)) return;
  if (prompt("برای تأیید، کلمه‌ی «بازگردانی» را بنویسید:") !== "بازگردانی") return setBackupMsg("بازگردانی انجام نشد؛ چیزی تغییر نکرد.", true);
  try {
    await LocalStore.restoreBackup(verifiedBackup.data);
    verifiedBackup = null;
    renderRestoreControls();
    renderAll();
    renderRecovery();
    setBackupMsg("داده از فایل بازگردانی شد. داده‌ی قبلی در پشتیبان محافظت‌شده است.", false);
  } catch (err) {
    setBackupMsg(backupErrorText(err), true);
    renderRestoreControls();
  }
}

// بازگردانی کامل روی سرور: پشتیبان سرور کامل اعتبارسنجی می‌شود و سرور پیش از جایگزینی نسخه می‌گیرد.
// اگر تغییری در صف آفلاین مانده باشد بازگردانی انجام نمی‌شود، چون با داده‌ی جدید ناسازگار می‌شود.
async function restoreOnServer() {
  if (!verifiedBackup || verifiedBackup.kind !== "server") return;
  if ((await Sync.pendingCount()) > 0) {
    return setBackupMsg("ابتدا تغییرهای همگام‌نشده را ارسال کنید؛ در غیر این صورت با بازگردانی از بین می‌روند. چیزی تغییر نکرد.", true);
  }
  const c = verifiedBackup.counts;
  if (!confirm(`همه‌ی داده‌ی این مزون روی سرور با این فایل جایگزین می‌شود (مشتری ${c.customers}، سفارش ${c.orders}، همکار ${c.staff}، تراکنش ${c.transactions}). داده‌ی فعلی پیش از آن روی سرور ذخیره می‌شود. ادامه می‌دهید؟`)) return;
  if (prompt("برای تأیید، کلمه‌ی «بازگردانی» را بنویسید:") !== "بازگردانی") return setBackupMsg("بازگردانی انجام نشد؛ چیزی تغییر نکرد.", true);
  setBackupMsg("در حال بازگردانی روی سرور…", false);
  try {
    const result = await Api.replaceFromBackup(verifiedBackup.data);
    verifiedBackup = null;
    renderRestoreControls();
    await loadRemote();
    renderAll();
    setBackupMsg(`داده از فایل بازگردانی شد. نسخه‌ی پیش از بازگردانی روی سرور ذخیره شد (شناسه: ${result.snapshot_id}).`, false);
  } catch (err) {
    setBackupMsg(err.status === 401 ? "نشست شما پایان یافته است؛ دوباره وارد شوید. چیزی تغییر نکرد." : (err.message || backupErrorText(err)), true);
    renderRestoreControls();
  }
}

// آخرین نسخه‌ی پیش از بازگردانی را به همان شکل پشتیبان دانلود می‌کند
async function downloadLatestSnapshot() {
  try {
    const { items } = await Api.snapshots();
    if (!items.length) return setBackupMsg("هنوز نسخه‌ای پیش از بازگردانی ذخیره نشده است.", true);
    const payload = await Api.snapshot(items[0].id);
    downloadText(`dokhtyar-snapshot-${String(items[0].created_at).slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
    setBackupMsg("نسخه‌ی پیش از آخرین بازگردانی دانلود شد.", false);
  } catch (err) {
    setBackupMsg(err.message || backupErrorText(err), true);
  }
}

// بازگردانی داده‌های نمونه از همان مسیر ایمن بازگردانی فایل: داده‌ی فعلی پیش از آن در پشتیبان محافظت‌شده می‌ماند
async function resetData() {
  if (REMOTE) return;
  const blocked = LocalStore.restoreBlockedReason();
  if (blocked) return toast(blocked);
  if (!confirm("داده‌ها به حالت نمونه برمی‌گردند. داده‌ی فعلی در پشتیبان محافظت‌شده نگه داشته می‌شود و حذف نمی‌شود. ادامه می‌دهید؟")) return;
  try {
    await LocalStore.restoreBackup(cloneSeed());
    renderAll();
    toast("داده‌ها به حالت نمونه برگشتند. داده‌ی قبلی در پشتیبان محافظت‌شده است.");
  } catch (err) {
    toast(err.message || "بازگردانی داده‌ی نمونه انجام نشد؛ چیزی تغییر نکرد.");
  }
}

/* ---------- مودال‌ها ---------- */

const MODALS = { order: "orderForm", customer: "customerForm", staff: "staffForm", tx: "txForm" };

function openModal(which) {
  $("#modalBackdrop").classList.add("open");
  Object.entries(MODALS).forEach(([k, id]) => $("#" + id).classList.toggle("show", k === which));
  $("#" + MODALS[which] + " input, #" + MODALS[which] + " select")?.focus();
}

function closeModal() {
  $("#modalBackdrop").classList.remove("open");
  $$(".modal").forEach((m) => {
    m.classList.remove("show");
    m.reset();
  });
}

/* ---------- ثبت داده‌ی جدید ---------- */

// تاریخ شمسی فرم → ISO؛ خالی = null؛ نامعتبر = undefined
function formDateToIso(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  const iso = Jalali.jalaliStringToISO(v);
  return iso || undefined;
}

// مبلغ عدد صحیح و نامنفی است؛ خالی یعنی ۰. ورودی نامعتبر (متن، اعشار، منفی) null می‌دهد و هرگز بی‌صدا ۰ نمی‌شود.
function parseWholeAmount(raw) {
  const s = toEnDigits(String(raw ?? "")).replace(/[,٬\s]/g, "");
  if (s === "") return 0;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

async function submitOrder(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  const customerName = String(d.get("customer")).trim();
  const description = String(d.get("description")).trim();
  const type = d.get("type");
  const status = d.get("status");
  if (!customerName) { toast("نام مشتری را وارد کنید."); return; }
  const price = parseWholeAmount(d.get("price"));
  if (price === null) { toast("قیمت باید عدد صحیح و بدون اعشار باشد."); return; }
  // حالت محلی: سفارش جدید برای مشتری حذف‌شده ثبت نمی‌شود تا قفل‌شده و بی‌صاحب نماند
  if (!REMOTE && localCustomerDeleted(customerName)) {
    toast("این مشتری حذف شده است؛ ابتدا او را از بخش «حذف‌شده‌ها» بازگردانید.");
    return;
  }

  if (REMOTE) {
    const dueIso = formDateToIso(d.get("due"));
    if (dueIso === undefined) { toast("تاریخ تحویل باید به شکل ۱۴۰۵/۰۹/۲۰ باشد."); return; }
    const ok = await run(async () => {
      const found = state.customers.find((c) => c.name === customerName);
      let queued = false;
      let customerId = found ? found.uuid : null;
      if (!customerId) {
        customerId = Sync.uuid();
        queued = (await w("POST", "/customers", { id: customerId, name: customerName }, { title: `مشتری: ${customerName}`, detail: "" })) || queued;
      }
      queued = (await w("POST", "/orders", {
        id: Sync.uuid(), customer_id: customerId, type, description, price, due_on: dueIso, status,
      }, { title: `سفارش: ${customerName}`, detail: description || type })) || queued;
      return queued;
    }, "سفارش جدید با موفقیت ثبت شد.");
    if (ok) { closeModal(); go("orders"); }
    return;
  }

  // تاریخ تحویل محلی باید تاریخ شمسی معتبر باشد؛ خالی یعنی «تعیین نشده»
  const dueRaw = String(d.get("due") || "").trim();
  let dueText = "تعیین نشده";
  if (dueRaw) {
    const dueIso = Jalali.jalaliStringToISO(dueRaw);
    if (!dueIso) { toast("تاریخ تحویل باید معتبر و به شکل ۱۴۰۵/۰۹/۲۰ باشد."); return; }
    dueText = toFaDigits(Jalali.isoToJalaliString(dueIso));
  }

  state.orders.unshift({
    id: nextOrderId(),
    customer: customerName,
    type,
    desc: description,
    created: TODAY_JALALI,
    due: dueText,
    status,
    price,
  });
  persist();
  closeModal();
  go("orders");
  renderDashboard();
  toast("سفارش جدید با موفقیت ثبت شد.");
}

async function submitCustomer(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  const name = String(d.get("name")).trim();
  const phone = String(d.get("phone")).trim();
  const note = String(d.get("note") || "").trim();
  if (!name) { toast("نام مشتری را وارد کنید."); return; }

  if (REMOTE) {
    const ok = await run(() => w("POST", "/customers", { id: Sync.uuid(), name, phone, note }, { title: `مشتری: ${name}`, detail: phone }), "مشتری جدید اضافه شد.");
    if (ok) { closeModal(); go("customers"); }
    return;
  }

  // حالت محلی: نام، شناسه‌ی مشتری است. نام تکراری (حتی حذف‌شده) ثبت نمی‌شود تا سفارش‌های
  // مشتری حذف‌شده به مشتری فعال تازه وصل نشوند.
  const same = state.customers.find((c) => c.name === name);
  if (same) {
    toast(same.deletedAt
      ? "یک مشتری حذف‌شده با همین نام وجود دارد؛ آن را از بخش «حذف‌شده‌ها» بازگردانید."
      : "مشتری دیگری با همین نام ثبت شده است.");
    return;
  }
  state.customers.unshift({ name, phone: toFaDigits(phone), count: 0, last: "—", state: "فعال", note });
  persist();
  closeModal();
  go("customers");
  toast("مشتری جدید اضافه شد.");
}

async function submitStaff(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  const name = String(d.get("name")).trim();
  const role = String(d.get("role") || "").trim();
  const phone = String(d.get("phone") || "").trim();
  if (!name) { toast("نام همکار را وارد کنید."); return; }

  if (REMOTE) {
    const ok = await run(() => w("POST", "/staff", { id: Sync.uuid(), name, role_title: role, phone }, { title: `همکار: ${name}`, detail: role || "" }), "همکار جدید اضافه شد.");
    if (ok) { closeModal(); go("coworkers"); }
    return;
  }

  state.staff.unshift({
    id: nextId(state.staff), name, role: role || "—", phone: toFaDigits(phone), active: true,
  });
  persist();
  closeModal();
  go("coworkers");
  toast("همکار جدید اضافه شد.");
}

async function submitTransaction(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  const amount = parseWholeAmount(d.get("amount"));
  if (amount === null || amount <= 0) {
    toast("مبلغ باید عدد صحیح و بزرگ‌تر از صفر باشد.");
    return;
  }

  if (REMOTE) {
    const dayIso = formDateToIso(d.get("date"));
    if (dayIso === undefined) { toast("تاریخ باید به شکل ۱۴۰۵/۰۸/۱۶ باشد."); return; }
    const ok = await run(() => w("POST", "/transactions", {
      id: Sync.uuid(),
      kind: d.get("kind"),
      category: d.get("category"),
      amount,
      occurred_on: dayIso,
      note: String(d.get("note") || "").trim(),
    }, { title: `تراکنش: ${toFaDigits(String(amount))} تومان`, detail: String(d.get("note") || "").trim() }), "تراکنش ثبت شد.");
    if (ok) { closeModal(); go("finance"); }
    return;
  }

  // تاریخ محلی تراکنش باید معتبر باشد؛ خالی یعنی امروز
  const dateRaw = String(d.get("date") || "").trim();
  let dateText = TODAY_JALALI;
  if (dateRaw) {
    const dayIso = Jalali.jalaliStringToISO(dateRaw);
    if (!dayIso) { toast("تاریخ باید معتبر و به شکل ۱۴۰۵/۰۸/۱۶ باشد."); return; }
    dateText = toFaDigits(Jalali.isoToJalaliString(dayIso));
  }

  state.transactions.push({
    id: nextId(state.transactions),
    date: dateText,
    kind: d.get("kind"),
    category: d.get("category"),
    amount,
    note: String(d.get("note") || "").trim(),
  });
  persist();
  closeModal();
  go("finance");
  toast("تراکنش ثبت شد.");
}

/* ---------- انتقال داده‌های این مرورگر به سرور (یک‌باره) ---------- */

// داده‌ی ساده‌ی محلی پیش از پاک شدن حالت سرور (فقط خواندنی؛ از نسخه‌ی رمزشده یا قدیمی)
let legacyData = null;
let currentRole = null;

function legacyCounts() {
  const d = legacyData || {};
  const n = (k) => (Array.isArray(d[k]) ? d[k].length : 0);
  return { customers: n("customers"), orders: n("orders"), staff: n("staff"), transactions: n("transactions") };
}

function serverIsEmpty() {
  return !state.customers.length && !state.orders.length && !state.staff.length && !state.transactions.length;
}

function renderImport() {
  const btn = $("#importBtn");
  if (!btn) return;
  const c = legacyCounts();
  const total = c.customers + c.orders + c.staff + c.transactions;
  const show = REMOTE && currentRole === "admin" && !!legacyData && total > 0 && serverIsEmpty();
  btn.hidden = !show;
  if (show) {
    btn.textContent = `وارد کردن داده‌های این مرورگر (${toFaDigits(c.customers)} مشتری، ${toFaDigits(c.orders)} سفارش)`;
  }
}

// تاریخ شمسی ذخیره‌شده → ISO؛ «تعیین نشده» یا نامعتبر = null
function legacyDateToIso(text) {
  const v = String(text || "").trim();
  if (!v || v === "تعیین نشده") return null;
  return Jalali.jalaliStringToISO(v) || null;
}

const LEGACY_TIER = { VIP: "vip", "فعال": "active", "معمولی": "regular" };

async function importLegacy() {
  const d = legacyData;
  if (!d) return;
  if (offlineMode) { toast("برای انتقال داده باید به اینترنت وصل باشید."); return; }
  if (!serverIsEmpty()) {
    toast("سرور قبلاً داده دارد؛ انتقال دوباره انجام نمی‌شود.");
    return;
  }
  const c = legacyCounts();
  const ok = confirm(
    `این داده‌ها به سرور منتقل شوند؟\n` +
    `${c.customers} مشتری، ${c.orders} سفارش، ${c.staff} همکار، ${c.transactions} تراکنش.\n\n` +
    `شماره و تاریخ ایجاد سفارش‌ها حفظ می‌شوند.`
  );
  if (!ok) return;

  const errors = [];
  const attempt = async (label, fn) => {
    try { return await fn(); } catch (err) { errors.push(`${label}: ${err.message || "خطا"}`); return null; }
  };
  const customerIdByName = {};

  for (const cu of d.customers || []) {
    const created = await attempt(`مشتری «${cu.name}»`, () => Api.createCustomer({
      name: String(cu.name || "").trim(),
      phone: toEnDigits(cu.phone || "").replace(/\s/g, "") || undefined,
      note: cu.note || undefined,
      tier: LEGACY_TIER[cu.state] || "regular",
    }));
    if (created) customerIdByName[created.name] = created.id;
  }

  for (const o of d.orders || []) {
    let customerId = customerIdByName[o.customer];
    if (!customerId) {
      const created = await attempt(`مشتری «${o.customer}»`, () => Api.createCustomer({ name: String(o.customer || "").trim() }));
      if (!created) continue;
      customerId = customerIdByName[created.name] = created.id;
    }
    // شماره‌ی اصلی از شناسه‌ی نمایشی «۱۴۰۵-۰۱۷» خوانده می‌شود
    const legacyNo = parseInt(toEnDigits(String(o.id || "")).split("-")[1], 10);
    await attempt(`سفارش «${o.desc}»`, () => Api.createOrder({
      customer_id: customerId,
      type: o.type,
      description: String(o.desc || "").trim() || "-",
      price: Math.max(0, Math.round(Number(toEnDigits(String(o.price ?? 0))) || 0)),
      due_on: legacyDateToIso(o.due),
      status: o.status,
      order_no: Number.isInteger(legacyNo) && legacyNo > 0 ? legacyNo : undefined,
      created_on: legacyDateToIso(o.created) || undefined,
    }));
  }

  for (const st of d.staff || []) {
    const created = await attempt(`همکار «${st.name}»`, () => Api.createStaff({
      name: String(st.name || "").trim(),
      role_title: st.role || "",
      phone: toEnDigits(st.phone || "") || undefined,
    }));
    if (created && st.active === false) {
      await attempt(`غیرفعال‌سازی «${st.name}»`, () => Api.patchStaff(created.id, { active: false }));
    }
  }

  for (const t of d.transactions || []) {
    const amount = Math.round(Number(toEnDigits(String(t.amount ?? 0))));
    if (!(amount > 0)) {
      errors.push(`تراکنش ${t.date || ""}: مبلغ نامعتبر`);
      continue;
    }
    await attempt(`تراکنش ${t.date || ""}`, () => Api.createTransaction({
      kind: t.kind,
      category: String(t.category || "سایر"),
      amount,
      occurred_on: legacyDateToIso(t.date),
      note: String(t.note || ""),
    }));
  }

  const s = d.settings || {};
  await attempt("تنظیمات", () => Api.saveSettings({
    shop_name: String(s.shopName || "").trim() || undefined,
    owner_name: String(s.ownerName || "").trim(),
    phone: toEnDigits(s.phone || ""),
    address: String(s.address || "").trim(),
    currency: String(s.currency || "").trim() || undefined,
  }));

  await loadRemote();
  renderAll();
  if (errors.length) {
    alert("بعضی موارد منتقل نشدند:\n\n" + errors.slice(0, 10).join("\n") + (errors.length > 10 ? `\n… و ${errors.length - 10} مورد دیگر` : ""));
    toast("انتقال با خطا کامل شد؛ موارد ناموفق در پیام نمایش داده شدند.");
  } else {
    toast("داده‌های این مرورگر با موفقیت به سرور منتقل شدند.");
  }
}

/* ---------- اتصال رویدادها ---------- */

function bindEvents() {
  $("#loginForm").addEventListener("submit", submitLogin);
  $("#logoutBtn").addEventListener("click", logout);
  $("#importBtn").addEventListener("click", importLegacy);

  $$(".nav-item").forEach((b) => b.addEventListener("click", () => go(b.dataset.page)));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => go(b.dataset.goto)));

  $("#ordersBody").addEventListener("click", (e) => {
    const del = e.target.closest("[data-delete-order]");
    if (del) return deleteOrderRecord(del.dataset.deleteOrder);
    const btn = e.target.closest("[data-status-index]");
    if (btn) changeOrderStatus(+btn.dataset.statusIndex);
  });

  $("#customersBody").addEventListener("click", (e) => {
    const del = e.target.closest("[data-delete-customer]");
    if (del) return deleteCustomerRecord(del.dataset.deleteCustomer);
    const detailBtn = e.target.closest("[data-detail]");
    const row = e.target.closest("[data-customer]");
    if (detailBtn) showCustomer(+detailBtn.dataset.detail);
    else if (row) showCustomer(+row.dataset.customer);
  });

  $("#staffBody").addEventListener("click", (e) => {
    const del = e.target.closest("[data-delete-staff]");
    if (del) return deleteStaffRecord(del.dataset.deleteStaff);
    const btn = e.target.closest("[data-toggle-staff]");
    if (btn) toggleStaff(btn.dataset.toggleStaff);
  });

  $("#custDeletedBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-restore-customer]");
    if (btn) restoreRecord("customer", btn.dataset.restoreCustomer);
  });
  $("#orderDeletedBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-restore-order]");
    if (btn) restoreRecord("order", btn.dataset.restoreOrder);
  });
  $("#staffDeletedBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-restore-staff]");
    if (btn) restoreRecord("staff", btn.dataset.restoreStaff);
  });

  $("#txBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-delete-tx]");
    if (btn) deleteTransaction(btn.dataset.deleteTx);
  });

  $$(".chip[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".chip[data-filter]").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      activeOrderFilter = b.dataset.filter;
      renderOrders();
    })
  );

  $$(".chip[data-tx-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".chip[data-tx-filter]").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      activeTxFilter = b.dataset.txFilter;
      renderFinance();
    })
  );

  $("#orderSearch").addEventListener("input", renderOrders);
  $$('input[name="status"], input[name="kind"]').forEach((x) => x.addEventListener("change", renderOrders));

  $("#resetFilters").addEventListener("click", () => {
    $('input[name="status"][value="all"]').checked = true;
    $$('input[name="kind"]').forEach((x) => (x.checked = true));
    activeOrderFilter = "all";
    $$(".chip[data-filter]").forEach((x) => x.classList.toggle("selected", x.dataset.filter === "all"));
    renderOrders();
  });

  $("#customerSearch").addEventListener("input", renderCustomers);

  $("#addOrderBtn").addEventListener("click", () => openModal("order"));
  $("#addCustomerBtn").addEventListener("click", () => openModal("customer"));
  $("#addStaffBtn").addEventListener("click", () => openModal("staff"));
  $("#addTxBtn").addEventListener("click", () => openModal("tx"));
  $$("[data-new-order]").forEach((b) =>
    b.addEventListener("click", () => {
      openModal("order");
      $("#orderForm [name=type]").value = b.dataset.newOrder;
    })
  );

  $$("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  $("#modalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "modalBackdrop") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#modalBackdrop").classList.contains("open")) closeModal();
  });

  $("#orderForm").addEventListener("submit", submitOrder);
  $("#customerForm").addEventListener("submit", submitCustomer);
  $("#staffForm").addEventListener("submit", submitStaff);
  $("#txForm").addEventListener("submit", submitTransaction);
  $("#settingsForm").addEventListener("submit", submitSettings);
  $("#exportBtn").addEventListener("click", exportData);
  $("#exportEncryptedBtn").addEventListener("click", exportEncryptedData);
  $("#backupCheckBtn").addEventListener("click", checkBackupFile);
  $("#backupRestoreBtn").addEventListener("click", restoreVerifiedBackup);
  $("#monthlyRange").addEventListener("change", renderMonthlyChart);
  $("#backupCheckFile").addEventListener("change", () => { verifiedBackup = null; renderRestoreControls(); });
  $("#resetBtn").addEventListener("click", resetData);
  $("#downloadSnapshotBtn").hidden = !REMOTE;
  $("#downloadSnapshotBtn").addEventListener("click", downloadLatestSnapshot);
  $("#txDeletedBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-restore-tx]");
    if (btn) restoreTransaction(btn.dataset.restoreTx);
  });

  $("#globalSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      go("orders");
      $("#orderSearch").value = e.target.value;
      renderOrders();
    }
  });
}

// حالت محلی: داده‌ی رمزشده قبل از هر رندر و قبل از فعال شدن رویدادها خوانده می‌شود،
// تا هیچ تغییری روی داده‌ی نمونه (قبل از خواندن واقعی) ذخیره نشود.
async function bootLocal() {
  const st = await LocalStore.init({
    storage: localStorage,
    target: state,
    seed: cloneSeed,
    onError: () => toast(STORE_ERROR_MSG),
  });
  bindEvents();
  document.body.dataset.ready = "true"; // رویدادها فعال شده‌اند؛ پیش از این کلیک‌ها نادیده گرفته می‌شوند
  // اگر نوشتنی هنوز به localStorage نرسیده، یا تغییری فقط در حالت فقط‌نشست مانده، بستن صفحه از بین می‌رود؛ مرورگر تأیید می‌خواهد
  window.addEventListener("beforeunload", (e) => {
    if (LocalStore.pendingCount() > 0 || LocalStore.getStatus().sessionDirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  LocalStore.subscribe(renderSaveIndicator); // وضعیت واقعی نوشتن؛ «ذخیره شد» فقط بعد از بازخوانی موفق
  renderBackupReminder();
  $("#recoveryImport").addEventListener("click", importLegacyData);
  $("#recoveryUndo").addEventListener("click", undoRecovery);
  refreshPersistence(); // درخواست ماندگاری؛ غیرهمزمان و بدون توقف برنامه
  if (st.locked) {
    showLocalLock(st);
    return;
  }
  renderSessionBanner(st.sessionOnly, st.reason === "key_unpersistable" ? KEY_UNPERSISTABLE_TEXT : LOCAL_SESSION_TEXT);
  if (st.migrationPending) toast("انتقال به حالت رمزشده کامل نشد؛ نسخه‌ی ساده‌ی قبلی دست‌نخورده مانده است.");
  if (st.staleLegacy) toast("یک نسخه‌ی ساده‌ی قدیمی از داده روی این دستگاه مانده و دست‌نخورده است. از بخش «بازیابی» در تنظیمات می‌توانید آن را بررسی کنید.");
  if (st.legacyKept && st.sessionOnly) toast("نسخه‌ی ساده‌ی قدیمی روی این دستگاه دست‌نخورده مانده و در این مرورگر منتقل نشده است.");
  renderAll();
  renderRecovery();
}

const SAVE_TEXT = {
  saving: "در حال ذخیره…",
  busy: "در حال بازیابی…",
  saved: "ذخیره شد",
  session: "فقط در این صفحه",
};

function renderSaveIndicator(st) {
  const el = $("#saveIndicator");
  const text = st.state === "error" ? (st.error || "ذخیره نشد") : SAVE_TEXT[st.state];
  el.hidden = !text;
  el.textContent = text || "";
  el.dataset.state = st.state;
}

const LOCAL_SESSION_TEXT = "ذخیره‌ی دائمی در این مرورگر فعال نیست؛ داده فقط تا بستن این صفحه می‌ماند. پیش از خروج، پشتیبان JSON بگیرید.";
const KEY_UNPERSISTABLE_TEXT = "این مرورگر نمی‌تواند کلید رمزنگاری را روی این دستگاه نگه دارد؛ داده فقط تا بستن این صفحه می‌ماند. پیش از خروج، پشتیبان JSON یا رمزشده بگیرید.";
const SERVER_SESSION_TEXT = "این مرورگر IndexedDB ندارد؛ تغییرات آفلاین فقط تا بستن این صفحه نگه داشته می‌شوند و پیش از خروج همگام نشده‌اند.";

function renderSessionBanner(on, text) {
  const banner = $("#sessionBanner");
  banner.hidden = !on;
  $("#sessionBannerText").textContent = text;
}

// وضعیت ماندگاری داده در بخش «داده‌ها» تنظیمات (فقط حالت محلی)
const PERSIST_TEXT = {
  granted: "ماندگاری داده: فعال است. مرورگر داده را خودکار پاک نمی‌کند؛ با این حال پشتیبان JSON را منظم نگه دارید.",
  denied: "ماندگاری داده: مرورگر اجازه‌ی ماندگاری دائمی نداد. داده ممکن است در شرایط کمبود فضا پاک شود؛ پشتیبان JSON را منظم دانلود کنید.",
  unsupported: "ماندگاری داده: این مرورگر درخواست ماندگاری را پشتیبانی نمی‌کند. پشتیبان JSON را منظم دانلود کنید.",
};
async function refreshPersistence() {
  const info = await LocalStore.requestPersistence();
  const el = $("#persistText");
  if (!el) return;
  el.textContent = PERSIST_TEXT[!info.supported ? "unsupported" : info.persisted ? "granted" : "denied"];
  el.hidden = false;
}

// بخش بازیابی: داده‌ی قدیمی مانده یا پشتیبان موجود است
function renderRecovery() {
  const panel = $("#recoveryPanel");
  const info = LocalStore.recoveryInfo();
  panel.hidden = !info;
  if (!info) return;
  const counts = (c) => (c ? `مشتری ${c.customers} · سفارش ${c.orders} · همکار ${c.staff} · تراکنش ${c.transactions}` : "—");
  $("#recoveryText").textContent = info.legacyPresent
    ? (info.legacyCorrupt
      ? "یک نسخه‌ی ساده‌ی قدیمی خراب روی این دستگاه مانده و دست‌نخورده است."
      : "یک نسخه‌ی ساده‌ی قدیمی از داده روی این دستگاه مانده است. ممکن است تغییراتی باشد که بعد از مهاجرت در یک زبانه‌ی قدیمی ثبت شده.")
    : "یک پشتیبان از داده‌ی قبلی در این مرورگر نگه داشته شده است.";
  $("#recoveryCounts").textContent = `داده‌ی فعلی: ${counts(info.currentCounts)}` + (info.legacyCounts ? `\nنسخه‌ی قدیمی: ${counts(info.legacyCounts)}` : "");
  $("#recoveryImport").hidden = !info.legacyPresent || info.legacyCorrupt || info.backupExists;
  $("#recoveryUndo").hidden = !info.backupExists;
}

async function importLegacyData() {
  if (!confirm("داده‌ی فعلی با نسخه‌ی ساده‌ی قدیمی جایگزین می‌شود. داده‌ی فعلی پیش از آن، رمزشده در پشتیبان نگه داشته می‌شود و هیچ‌چیز حذف نمی‌شود. ادامه می‌دهید؟")) return;
  if (prompt("برای تأیید، کلمه‌ی «ورود» را بنویسید:") !== "ورود") {
    toast("بازیابی انجام نشد.");
    return;
  }
  try {
    const counts = await LocalStore.importLegacy();
    renderAll();
    toast(`داده‌ی قدیمی بازیابی شد (مشتری ${counts.customers}). داده‌ی قبلی در پشتیبان است.`);
  } catch (err) {
    toast(err.message);
  }
  renderRecovery();
}

async function undoRecovery() {
  if (!confirm("داده‌ی فعلی و پشتیبان جابه‌جا می‌شوند. هیچ‌چیز حذف نمی‌شود. ادامه می‌دهید؟")) return;
  try {
    await LocalStore.swapWithBackup();
    renderAll();
    toast("جابه‌جایی انجام شد.");
  } catch (err) {
    toast(err.message);
  }
  renderRecovery();
}

const LOCK_REASON = {
  key_missing: "کلید رمزنگاری این مرورگر پیدا نشد.",
  decrypt_failed: "داده‌ی رمزشده با کلید این مرورگر باز نمی‌شود.",
  corrupt: "ساختار داده‌ی ذخیره‌شده خراب است.",
  no_vault: "این مرورگر IndexedDB ندارد، پس داده‌ی رمزشده‌ی ذخیره‌شده را نمی‌توان باز کرد. با مرورگری که IndexedDB دارد باز کنید؛ هیچ‌چیز حذف نشده است.",
  vault_unavailable: "مرورگر در این لحظه به کلید رمزنگاری دسترسی ندارد. صفحه را دوباره باز کنید؛ هیچ داده‌ای حذف نشده است.",
};

function showLocalLock(st) {
  $("#localLockReason").textContent = LOCK_REASON[st.reason] || "داده‌ی ذخیره‌شده قابل خواندن نیست.";
  // خطای موقت دسترسی به کلید، حذف را پیشنهاد نمی‌کند
  $("#localDeleteBtn").hidden = st.reason === "vault_unavailable" || st.reason === "no_vault";
  $("#localLock").hidden = false;
  $("#localDeleteBtn").addEventListener("click", deleteLocalUnreadable);
}

// حذف فقط پاکت رمزشده‌ی ناخوانا؛ با دو تأیید جداگانه، و تنها وقتی که داده واقعاً قابل‌خواندن نیست
async function deleteLocalUnreadable() {
  if (!confirm("هشدار: داده‌ی رمزشده‌ی این مرورگر با کلید فعلی باز نمی‌شود. با حذف آن، این داده برای همیشه از بین می‌رود و قابل بازیابی نیست. داده‌ی قابل‌خواندن یا نسخه‌ی ساده‌ی قدیمی حذف نمی‌شود. ادامه می‌دهید؟")) return;
  const typed = prompt("برای تأیید نهایی، کلمه‌ی «حذف» را دقیقاً وارد کنید:");
  if (typed !== "حذف") { toast("حذف انجام نشد."); return; }
  try {
    await LocalStore.deleteUnreadable();
  } catch (err) {
    toast(err.message || "حذف انجام نشد.");
    return;
  }
  location.reload();
}

async function boot() {
  if (!REMOTE) {
    await bootLocal();
    return;
  }
  bindEvents();
  document.body.dataset.ready = "true";
  // حالت سرور: داده‌ی محلی برای انتقال نگه داشته می‌شود و نمایش داده نمی‌شود.
  // مهاجرت ساده→رمزشده همین‌جا هم انجام می‌شود (بدون اعمال روی state).
  await LocalStore.init({ storage: localStorage, target: null, seed: cloneSeed, onError: () => {} }).catch(() => {});
  if (!Sync.isPersistent()) {
    renderSessionBanner(true, SERVER_SESSION_TEXT);
    // بدون IndexedDB، تغییرهای در صف‌مانده فقط در همین صفحه‌اند؛ پیش از بستن صفحه هشدار بده
    window.addEventListener("beforeunload", (e) => {
      if (Sync.unsentSessionCount() > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }
  legacyData = await LocalStore.readPlain().catch(() => null);
  state.orders = [];
  state.customers = [];
  state.staff = [];
  state.transactions = [];
  renderAll();
  // داده‌ی قدیمی ساده را یک‌بار رمز کن (ایمن و تکرارشونده)، سپس خروج‌های ناتمام را با نشست قدیمی کامل کن
  await Sync.migrateLocalData().catch(() => {});
  await Sync.finishPendingLogouts().catch(() => {});
  let online = true;
  try {
    const me = await Api.me();
    currentRole = me.user?.role || null;
    if (await Sync.hasPendingLogout(me.user?.id)) {
      // خروج قبلی هنوز ثبت نشده: کاربر را دوباره وارد نمی‌کنیم
      showGate();
      renderAll();
      toast("خروج قبلی هنوز روی سرور ثبت نشده؛ با اتصال دوباره تلاش می‌شود.");
      return;
    }
    await Sync.beginSession(me.user?.id);
  } catch (err) {
    if (!Sync.isNetworkError(err)) {
      // نشست پایان یافته: نشانه‌ی کاربر پاک می‌شود، داده‌ی صف حذف نمی‌شود
      await Sync.endSession();
      showGate();
      renderAll();
      return;
    }
    online = false;
    // بدون اینترنت فقط داده‌ی کاربر آخرین نشست نمایش داده می‌شود
    const last = await Sync.lastScope();
    if (!last) {
      showGate();
      renderAll();
      toast("برای ورود به اینترنت نیاز است.");
      return;
    }
    Sync.restoreScope(last);
  }
  try {
    await loadRemote();
    hideGate();
  } catch (err) {
    showGate();
    if (Sync.isNetworkError(err)) toast("اتصال به اینترنت نیست و نسخه‌ی ذخیره‌شده‌ای روی این دستگاه نیست.");
  }
  renderAll();
  renderSync().catch(() => {});
  if (online) syncNow();
}

/* ---------- فاز ۳: PWA ---------- */

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register("sw.js").then(
    (reg) => {
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            toast("نسخه‌ی جدید دوخت‌یار آماده است؛ با بارگذاری مجدد اعمال می‌شود.");
          }
        });
      });
    },
    () => {}
  );
}

function bindConnectionStatus() {
  const show = () => {
    const offline = !navigator.onLine;
    document.body.classList.toggle("is-offline", offline);
    if (offline) toast("اتصال اینترنت قطع است؛ تغییرات روی این دستگاه ذخیره می‌شوند.");
  };
  window.addEventListener("offline", show);
  window.addEventListener("online", () => {
    toast("اتصال برقرار شد.");
    // خروج ناتمام کاربری که از صفحه‌ی ورود خارج شده هم اینجا کامل می‌شود
    Sync.finishPendingLogouts().catch(() => {});
    syncNow();
  });
  if (!navigator.onLine) show();
}

registerServiceWorker();
bindConnectionStatus();
bindSyncPanel();
boot();
