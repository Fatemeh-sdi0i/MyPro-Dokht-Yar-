/*
 * منطق رابط کاربری دوخت‌یار (فاز ۱: نمونه‌ی استاتیک قابل استقرار)
 * داده‌ها از js/data.js خوانده می‌شوند. این فایل به‌صورت script کلاسیک است تا با باز کردن مستقیم index.html هم کار کند.
 */

let activeFilter = "all";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 2300);
}

function go(page) {
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === page));
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === page));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- سفارش‌ها ---------- */

function matchesActiveFilter(order) {
  if (activeFilter === "all") return true;
  if (activeFilter === "sewing" || activeFilter === "repair") return order.type === activeFilter;
  return order.status === activeFilter; // progress | delivered
}

function renderOrders() {
  const q = ($("#orderSearch")?.value || "").trim().toLowerCase();
  const status = $('input[name="status"]:checked')?.value || "all";
  const kinds = $$('input[name="kind"]:checked').map((x) => x.value);

  const filtered = orders.filter(
    (o) =>
      matchesActiveFilter(o) &&
      (status === "all" || o.status === status) &&
      kinds.includes(o.type) &&
      (!q || [o.id, o.customer, o.desc].join(" ").toLowerCase().includes(q))
  );

  $("#ordersBody").innerHTML =
    filtered
      .map((o) => {
        const idx = orders.indexOf(o);
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
  const o = orders[idx];
  if (!o) return;
  o.status = NEXT_STATUS[o.status];
  renderOrders();
  renderUpcoming();
  toast("وضعیت سفارش به «" + ORDER_STATUS[o.status] + "» تغییر کرد.");
}

// برچسب کوتاه تاریخ تحویل مثل «۱۴ آبان»؛ اگر تاریخ معتبر نباشد متن خام نمایش داده می‌شود
function dueLabel(due) {
  const parts = toEnDigits(due).split("/");
  if (parts.length !== 3) return esc(due);
  return esc(toFaDigits(parseInt(parts[2], 10))) + " " + jalaliMonthName(due);
}

function renderUpcoming() {
  const rows = orders
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

/* ---------- مشتریان ---------- */

function renderCustomers() {
  const q = ($("#customerSearch")?.value || "").trim();
  const rows = customers.filter((c) => !q || (c.name + c.phone).includes(q));

  $("#customersBody").innerHTML =
    rows
      .map((c) => {
        const idx = customers.indexOf(c);
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

  $("#customerCount").textContent = toFaDigits(customers.length);
}

function showCustomer(i) {
  const c = customers[i];
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
    <div class="detail-note">♥ ${esc(c.note) || "یادداشتی برای این مشتری ثبت نشده است."}</div>
    <div class="detail-actions"><button type="button">ویرایش</button><button type="button">تماس</button></div>`;
}

/* ---------- مودال‌ها ---------- */

function openModal(which) {
  $("#modalBackdrop").classList.add("open");
  $("#orderForm").classList.toggle("show", which === "order");
  $("#customerForm").classList.toggle("show", which === "customer");
  const firstInput = $(`#${which === "order" ? "orderForm" : "customerForm"} input, #${which === "order" ? "orderForm" : "customerForm"} select`);
  firstInput?.focus();
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
  orders.unshift({
    id: nextOrderId(),
    customer: String(d.get("customer")).trim(),
    type: d.get("type"),
    desc: String(d.get("description")).trim(),
    created: TODAY_JALALI,
    due: toFaDigits(String(d.get("due") || "").trim()) || "تعیین نشده",
    status: d.get("status"),
    price: Number(d.get("price")) || 0,
  });
  renderOrders();
  renderUpcoming();
  closeModal();
  go("orders");
  toast("سفارش جدید با موفقیت ثبت شد.");
}

function submitCustomer(e) {
  e.preventDefault();
  const d = new FormData(e.target);
  customers.unshift({
    name: String(d.get("name")).trim(),
    phone: toFaDigits(String(d.get("phone")).trim()),
    count: 0,
    last: "—",
    state: "فعال",
    note: String(d.get("note") || "").trim(),
  });
  renderCustomers();
  closeModal();
  go("customers");
  toast("مشتری جدید اضافه شد.");
}

/* ---------- اتصال رویدادها ---------- */

function bindEvents() {
  $$(".nav-item").forEach((b) => b.addEventListener("click", () => go(b.dataset.page)));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => go(b.dataset.goto)));

  // delegation به‌جای اتصال مجدد listener بعد از هر رندر
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

  $$(".chip").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".chip").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      activeFilter = b.dataset.filter;
      renderOrders();
    })
  );

  $("#orderSearch").addEventListener("input", renderOrders);
  $$('input[name="status"], input[name="kind"]').forEach((x) => x.addEventListener("change", renderOrders));

  $("#resetFilters").addEventListener("click", () => {
    $('input[name="status"][value="all"]').checked = true;
    $$('input[name="kind"]').forEach((x) => (x.checked = true));
    activeFilter = "all";
    $$(".chip").forEach((x) => x.classList.toggle("selected", x.dataset.filter === "all"));
    renderOrders();
  });

  $("#customerSearch").addEventListener("input", renderCustomers);

  $("#addOrderBtn").addEventListener("click", () => openModal("order"));
  $("#addCustomerBtn").addEventListener("click", () => openModal("customer"));
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

  $("#globalSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      go("orders");
      $("#orderSearch").value = e.target.value;
      renderOrders();
    }
  });
}

bindEvents();
renderOrders();
renderCustomers();
renderUpcoming();
