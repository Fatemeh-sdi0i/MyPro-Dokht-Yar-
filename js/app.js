/*
 * منطق رابط کاربری دوخت‌یار — فاز ۲
 * داده‌ها از js/data.js (state و saveState) خوانده و ذخیره می‌شوند.
 */

let activeOrderFilter = "all";
let activeTxFilter = "all";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 2300);
}

function persist() {
  if (!saveState()) toast("ذخیره‌سازی در این مرورگر امکان‌پذیر نیست؛ تغییرات فقط تا بستن صفحه می‌مانند.");
}

function go(page) {
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === page));
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === page));
  window.scrollTo({ top: 0, behavior: "smooth" });
  renderPage(page);
}

// فقط بخش فعال را دوباره می‌سازیم
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
  return order.status === activeOrderFilter; // progress | delivered
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

function changeOrderStatus(idx) {
  const o = state.orders[idx];
  if (!o) return;
  o.status = NEXT_STATUS[o.status];
  persist();
  renderOrders();
  renderDashboard();
  toast("وضعیت سفارش به «" + ORDER_STATUS[o.status] + "» تغییر کرد.");
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
          <td><button class="chip" data-toggle-staff="${s.id}">${s.active ? "غیرفعال کردن" : "فعال کردن"}</button></td>
        </tr>`
      )
      .join("") || '<tr><td colspan="6">همکاری ثبت نشده است.</td></tr>';
}

function toggleStaff(id) {
  const s = state.staff.find((x) => x.id === id);
  if (!s) return;
  s.active = !s.active;
  persist();
  renderStaff();
  toast(s.active ? "همکار فعال شد." : "همکار غیرفعال شد.");
}

function submitStaff(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  state.staff.unshift({
    id: nextId(state.staff),
    name: String(d.get("name")).trim(),
    role: String(d.get("role") || "").trim() || "—",
    phone: toFaDigits(String(d.get("phone") || "").trim()),
    active: true,
  });
  persist();
  closeModal();
  go("coworkers");
  toast("همکار جدید اضافه شد.");
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

  const rows = state.transactions
    .filter((t) => activeTxFilter === "all" || t.kind === activeTxFilter)
    .slice()
    .sort((a, b) => b.id - a.id);

  $("#txBody").innerHTML =
    rows
      .map(
        (t) => `<tr>
          <td>${esc(t.date)}</td>
          <td><span class="status ${t.kind === "income" ? "delivered" : "ready"}">${t.kind === "income" ? "درآمد" : "هزینه"}</span></td>
          <td>${esc(t.category)}</td>
          <td>${esc(t.note) || "—"}</td>
          <td>${formatMoney(t.amount)}</td>
          <td><button class="chip" data-delete-tx="${t.id}">حذف</button></td>
        </tr>`
      )
      .join("") || '<tr><td colspan="6">تراکنشی برای نمایش وجود ندارد.</td></tr>';
}

function deleteTransaction(id) {
  if (!confirm("این تراکنش حذف شود؟")) return;
  state.transactions = state.transactions.filter((t) => t.id !== id);
  persist();
  renderFinance();
  renderReports();
  toast("تراکنش حذف شد.");
}

function submitTransaction(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  const amount = Number(toEnDigits(d.get("amount")));
  if (!(amount > 0)) {
    toast("مبلغ باید بزرگ‌تر از صفر باشد.");
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
      <article class="stat-card cream"><label>درآمد تحویل‌شده (${state.settings.currency})</label><strong class="small-num">${formatMoney(revenue)}</strong></article>
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

function submitSettings(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  state.settings = {
    shopName: String(d.get("shopName") || "").trim() || SEED.settings.shopName,
    ownerName: String(d.get("ownerName") || "").trim() || SEED.settings.ownerName,
    phone: toFaDigits(String(d.get("phone") || "").trim()),
    address: String(d.get("address") || "").trim(),
    currency: String(d.get("currency") || "").trim() || "تومان",
  };
  persist();
  applyOwnerBinding();
  renderReports();
  toast("تنظیمات ذخیره شد.");
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
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
  if (!confirm("همه‌ی داده‌ها به حالت نمونه برگردند؟ این کار قابل بازگشت نیست.")) return;
  const seed = cloneSeed();
  Object.assign(state, seed);
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

function submitOrder(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  state.orders.unshift({
    id: nextOrderId(),
    customer: String(d.get("customer")).trim(),
    type: d.get("type"),
    desc: String(d.get("description")).trim(),
    created: TODAY_JALALI,
    due: toFaDigits(String(d.get("due") || "").trim()) || "تعیین نشده",
    status: d.get("status"),
    price: Number(toEnDigits(d.get("price") || "0")) || 0,
  });
  persist();
  closeModal();
  go("orders");
  renderDashboard();
  toast("سفارش جدید با موفقیت ثبت شد.");
}

function submitCustomer(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  state.customers.unshift({
    name: String(d.get("name")).trim(),
    phone: toFaDigits(String(d.get("phone")).trim()),
    count: 0,
    last: "—",
    state: "فعال",
    note: String(d.get("note") || "").trim(),
  });
  persist();
  closeModal();
  go("customers");
  toast("مشتری جدید اضافه شد.");
}

/* ---------- اتصال رویدادها ---------- */

function bindEvents() {
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
    if (btn) toggleStaff(+btn.dataset.toggleStaff);
  });

  $("#txBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-delete-tx]");
    if (btn) deleteTransaction(+btn.dataset.deleteTx);
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

bindEvents();
renderAll();

/* ---------- فاز ۳: PWA ---------- */

function registerServiceWorker() {
  // فقط روی http(s) — در حالت file:// سرویس‌کار کار نمی‌کند
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
    () => {
      // ثبت سرویس‌کار شکست خورد؛ برنامه بدون کار آفلاین ادامه می‌دهد
    }
  );
}

function bindConnectionStatus() {
  const show = () => {
    const offline = !navigator.onLine;
    document.body.classList.toggle("is-offline", offline);
    if (offline) toast("اتصال اینترنت قطع است؛ تغییرات روی این دستگاه ذخیره می‌شوند.");
  };
  window.addEventListener("offline", show);
  window.addEventListener("online", () => toast("اتصال برقرار شد."));
  if (!navigator.onLine) show();
}

registerServiceWorker();
bindConnectionStatus();
