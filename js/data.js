/*
 * داده‌های نمونه (seed)، ذخیره‌سازی محلی و توابع کمکی مشترک.
 * فاز ۲: داده‌ها در localStorage ذخیره می‌شوند (فقط همین مرورگر).
 * در فاز بعدی (بک‌اند) این بخش با API جایگزین می‌شود.
 */

const TODAY_JALALI = "۱۴۰۵/۰۸/۲۶"; // امروز ۱۴۰۵/۰۸/۲۶ = ۲۰۲۶-۱۱-۱۷ (کنترل‌شده با js/jalali.js)
const STORAGE_KEY = "dokhtyar.v2";

const ORDER_STATUS = {
  waiting: "در انتظار شروع",
  progress: "در حال دوخت",
  ready: "آماده تحویل",
  delivered: "تحویل شده",
};

const ORDER_TYPE = { sewing: "دوخت لباس", repair: "تعمیرات" };

const NEXT_STATUS = {
  waiting: "progress",
  progress: "ready",
  ready: "delivered",
  delivered: "waiting",
};

const PERSIAN_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
];

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

const SEED = {
  orders: [
    { id: "۱۴۰۵-۰۲۱", customer: "مریم احمدی", type: "sewing", desc: "دوخت لباس مجلسی", created: "۱۴۰۵/۰۸/۱۰", due: "۱۴۰۵/۰۸/۱۴", status: "progress", price: 8500000 },
    { id: "۱۴۰۵-۰۲۰", customer: "نگار رضایی", type: "repair", desc: "تعمیر و اصلاح مانتو", created: "۱۴۰۵/۰۸/۰۹", due: "۱۴۰۵/۰۸/۱۲", status: "ready", price: 450000 },
    { id: "۱۴۰۵-۰۱۹", customer: "سارا موسوی", type: "sewing", desc: "دوخت مانتو", created: "۱۴۰۵/۰۸/۰۷", due: "۱۴۰۵/۰۸/۱۵", status: "delivered", price: 6200000 },
    { id: "۱۴۰۵-۰۱۸", customer: "الهام کریمی", type: "repair", desc: "کوتاهی و اصلاح لباس", created: "۱۴۰۵/۰۸/۰۶", due: "۱۴۰۵/۰۸/۱۳", status: "waiting", price: 380000 },
    { id: "۱۴۰۵-۰۱۷", customer: "پریا کاوه", type: "sewing", desc: "دوخت کت و دامن", created: "۱۴۰۵/۰۸/۰۵", due: "۱۴۰۵/۰۸/۱۶", status: "progress", price: 7400000 },
  ],
  customers: [
    { name: "مریم احمدی", phone: "۰۹۱۲۳۴۵۶۷۸۹", count: 5, last: "۱۴۰۵/۰۸/۱۴", state: "فعال", note: "مشتری دائمی و بسیار خوش‌سلیقه است." },
    { name: "نگار رضایی", phone: "۰۹۳۵۸۷۶۵۴۳۲", count: 7, last: "۱۴۰۵/۰۸/۱۰", state: "VIP", note: "ترجیح می‌دهد قبل از شروع کار، مدل نهایی تأیید شود." },
    { name: "سارا موسوی", phone: "۰۹۱۱۷۶۵۴۳۲۱", count: 2, last: "۱۴۰۵/۰۸/۰۹", state: "معمولی", note: "" },
    { name: "الهام کریمی", phone: "۰۹۸۷۶۵۴۳۲۱", count: 3, last: "۱۴۰۵/۰۸/۰۵", state: "فعال", note: "" },
    { name: "پریا کاوه", phone: "۰۹۳۷۸۹۱۲۳۴۵", count: 4, last: "۱۴۰۵/۰۸/۰۱", state: "معمولی", note: "" },
  ],
  staff: [
    { id: 1, name: "فاطمه سعیدی", role: "مدیر مزون", phone: "۰۹۱۰۱۱۱۲۲۳۳", active: true },
    { id: 2, name: "زهرا نوری", role: "خیاط ارشد", phone: "۰۹۱۲۵۵۵۶۶۷۷", active: true },
    { id: 3, name: "لیلا احمدی", role: "طراح لباس", phone: "۰۹۳۵۸۸۸۹۹۰۰", active: false },
  ],
  transactions: [
    { id: 1, date: "۱۴۰۵/۰۸/۰۲", kind: "expense", category: "پارچه", amount: 2400000, note: "خرید پارچه کرپ" },
    { id: 2, date: "۱۴۰۵/۰۸/۰۵", kind: "income", category: "سایر", amount: 500000, note: "فروش الگو" },
    { id: 3, date: "۱۴۰۵/۰۸/۰۸", kind: "expense", category: "اجاره", amount: 3000000, note: "اجاره‌ی ماهانه‌ی مغازه" },
  ],
  settings: { shopName: "مزون دوخت‌یار", ownerName: "فاطمه سعیدی", phone: "", address: "", currency: "تومان" },
};

const TRANSACTION_CATEGORIES = ["پارچه", "اجاره", "حقوق", "ابزار", "حمل‌ونقل", "سایر"];

/* ---------- ذخیره‌سازی (با try/catch برای حالت‌های بدون دسترسی به localStorage) ---------- */

function cloneSeed() {
  return JSON.parse(JSON.stringify(SEED));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneSeed();
    const parsed = JSON.parse(raw);
    const seed = cloneSeed();
    return {
      orders: Array.isArray(parsed.orders) ? parsed.orders : seed.orders,
      customers: Array.isArray(parsed.customers) ? parsed.customers : seed.customers,
      staff: Array.isArray(parsed.staff) ? parsed.staff : seed.staff,
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : seed.transactions,
      settings: { ...seed.settings, ...(parsed.settings || {}) },
    };
  } catch (err) {
    return cloneSeed();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    return false;
  }
}

const state = loadState();

/* ---------- توابع کمکی عددی و امنیتی ---------- */

// تبدیل ارقام فارسی/عربی به انگلیسی
function toEnDigits(str) {
  return String(str)
    .replace(/[۰-۹]/g, (d) => FA_DIGITS.indexOf(d))
    .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660);
}

// تبدیل ارقام انگلیسی به فارسی
function toFaDigits(value) {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[+d]);
}

// قالب پول: ۲۴,۸۸۵,۰۰۰
function formatMoney(n) {
  return toFaDigits(Math.round(Number(n) || 0).toLocaleString("en-US"));
}

// جلوگیری از تزریق HTML هنگام نمایش داده‌های کاربر
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// نام ماه فارسی از تاریخ جلالی به شکل ۱۴۰۵/۰۸/۱۴
function jalaliMonthName(dateStr) {
  const month = parseInt(toEnDigits(dateStr).split("/")[1], 10);
  return PERSIAN_MONTHS[month - 1] || "";
}

// شماره سفارش بعدی بر اساس بیشترین شماره موجود
function nextOrderId() {
  const max = state.orders.reduce((m, o) => Math.max(m, parseInt(toEnDigits(o.id).split("-")[1], 10) || 0), 0);
  return "۱۴۰۵-" + toFaDigits(String(max + 1).padStart(3, "0"));
}

// شناسه‌ی عددی یکتا برای رکوردهای جدید
function nextId(list) {
  return list.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
}
