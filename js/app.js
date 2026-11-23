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
  const [cust, ords, staff, txs, settings] = await Promise.all([
    Api.customers(), Api.orders(), Api.staff(), Api.transactions(), Api.settings(),
  ]);
  return { customers: cust.items, orders: ords.items, staff: staff.items, transactions: txs.items, settings };
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
    name: c.name,
    phone: toFaDigits(c.phone || ""),
    count: c.order_count,
    last: lastByCustomer[c.id] || "—",
    state: TIER_LABEL[c.tier] || "معمولی",
    note: c.note || "",
  }));
  state.staff = d.staff.map((s) => ({
    id: s.id, name: s.name, role: s.role_title, phone: toFaDigits(s.phone || ""), active: s.active,
  }));
  state.transactions = d.transactions.map((t) => ({
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
  const local = await Sync.localDataStatus().catch(() => ({ encrypted: false, unreadable: 0 }));
  $("#syncLocked").hidden = !local.unreadable;
  $("#syncLocked").textContent = local.unreadable ? Sync.LOCKED_MSG + " تا رفع مشکل، ارسال متوقف است." : "";
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

function bindSyncPanel() {
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

/* ---------- داشبورد ---------- */

function countByStatus(status) {
  return state.orders.filter((o) => o.status === status).length;
}

function deliveredRevenue() {
  return state.orders.filter((o) => o.status === "delivered").reduce((sum, o) => sum + (Number(o.price) || 0), 0);
}

function renderDashboard() {
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
  const rows = state.orders
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

  const filtered = state.orders.filter(
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
          <td><button class="dots" title="تغییر وضعیت" data-status-index="${idx}">•••</button></td>
        </tr>`;
      })
      .join("") || '<tr><td colspan="8">سفارشی با این مشخصات پیدا نشد.</td></tr>';
}

async function changeOrderStatus(idx) {
  const o = state.orders[idx];
  if (!o) return;
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
  const rows = state.customers.filter((c) => !q || (c.name + c.phone).includes(q));

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
          <td><button class="dots" data-detail="${idx}">•••</button></td>
        </tr>`;
      })
      .join("") || '<tr><td colspan="7">مشتری پیدا نشد.</td></tr>';

  $("#customerCount").textContent = toFaDigits(state.customers.length);
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
  const active = state.staff.filter((s) => s.active).length;
  $("#staffCount").textContent = toFaDigits(state.staff.length);
  $("#staffActive").textContent = toFaDigits(active);
  $("#staffBody").innerHTML =
    state.staff
      .map(
        (s) => `<tr>
          <td><span class="mini-avatar">${esc(s.name[0])}</span></td>
          <td>${esc(s.name)}</td>
          <td>${esc(s.role)}</td>
          <td>${esc(s.phone)}</td>
          <td><span class="status ${s.active ? "delivered" : "waiting"}">${s.active ? "فعال" : "غیرفعال"}</span></td>
          <td><button class="chip" data-toggle-staff="${esc(s.id)}">${s.active ? "غیرفعال کردن" : "فعال کردن"}</button></td>
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

function renderFinance() {
  const manualIncome = state.transactions.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0);
  const expense = state.transactions.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0);
  const orderIncome = deliveredRevenue();
  const balance = orderIncome + manualIncome - expense;

  $("#finOrderIncome").textContent = formatMoney(orderIncome);
  $("#finOtherIncome").textContent = formatMoney(manualIncome);
  $("#finExpense").textContent = formatMoney(expense);
  $("#finBalance").textContent = formatMoney(balance);

  const filtered = state.transactions.filter((t) => activeTxFilter === "all" || t.kind === activeTxFilter);
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
}

async function deleteTransaction(id) {
  if (!confirm("این تراکنش حذف شود؟")) return;
  if (REMOTE) {
    await run(() => w("DELETE", `/transactions/${id}`, undefined, { title: "حذف تراکنش", detail: "" }), "تراکنش حذف شد.");
    return;
  }
  state.transactions = state.transactions.filter((t) => String(t.id) !== String(id));
  persist();
  renderFinance();
  renderReports();
  toast("تراکنش حذف شد.");
}

/* ---------- گزارش‌ها ---------- */

function renderReports() {
  const orders = state.orders;
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

async function exportData() {
  let payload;
  if (REMOTE) {
    try { payload = await Api.exportJson(); }
    catch (err) { toast(err.message || "دانلود پشتیبان انجام نشد"); return; }
  } else {
    payload = state;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "dokhtyar-backup.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetData() {
  if (REMOTE) return;
  if (!confirm("همه‌ی داده‌ها به حالت نمونه برگردند؟ این کار قابل بازگشت نیست.")) return;
  Object.assign(state, cloneSeed());
  persist();
  renderAll();
  toast("داده‌ها به حالت اولیه برگشتند.");
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

async function submitOrder(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  const customerName = String(d.get("customer")).trim();
  const description = String(d.get("description")).trim();
  const type = d.get("type");
  const status = d.get("status");
  const price = Number(toEnDigits(d.get("price") || "0")) || 0;

  if (REMOTE) {
    if (!Number.isInteger(price) || price < 0) { toast("قیمت باید عدد صحیح و بدون اعشار باشد."); return; }
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

  state.orders.unshift({
    id: nextOrderId(),
    customer: customerName,
    type,
    desc: description,
    created: TODAY_JALALI,
    due: toFaDigits(String(d.get("due") || "").trim()) || "تعیین نشده",
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

  if (REMOTE) {
    const ok = await run(() => w("POST", "/customers", { id: Sync.uuid(), name, phone, note }, { title: `مشتری: ${name}`, detail: phone }), "مشتری جدید اضافه شد.");
    if (ok) { closeModal(); go("customers"); }
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
  const amount = Number(toEnDigits(d.get("amount")));
  if (!(amount > 0)) {
    toast("مبلغ باید بزرگ‌تر از صفر باشد.");
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

  state.transactions.push({
    id: nextId(state.transactions),
    date: toFaDigits(String(d.get("date") || "").trim()) || TODAY_JALALI,
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

// داده‌ی خام localStorage پیش از پاک شدن حالت سرور (فقط خواندنی)
let legacyData = null;
let currentRole = null;

function readLegacy() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

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
    const btn = e.target.closest("[data-status-index]");
    if (btn) changeOrderStatus(+btn.dataset.statusIndex);
  });

  $("#customersBody").addEventListener("click", (e) => {
    const detailBtn = e.target.closest("[data-detail]");
    const row = e.target.closest("[data-customer]");
    if (detailBtn) showCustomer(+detailBtn.dataset.detail);
    else if (row) showCustomer(+row.dataset.customer);
  });

  $("#staffBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-toggle-staff]");
    if (btn) toggleStaff(btn.dataset.toggleStaff);
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
  $("#resetBtn").addEventListener("click", resetData);

  $("#globalSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      go("orders");
      $("#orderSearch").value = e.target.value;
      renderOrders();
    }
  });
}

async function boot() {
  bindEvents();
  if (!REMOTE) {
    renderAll();
    return;
  }
  // حالت سرور: داده‌ی محلی برای انتقال نگه داشته می‌شود و نمایش داده نمی‌شود
  legacyData = readLegacy();
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
