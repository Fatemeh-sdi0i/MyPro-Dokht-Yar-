/*
 * داده‌های نمونه (seed) و توابع کمکی مشترک.
 * فعلاً داده‌ها در حافظه‌ی مرورگر هستند و با بارگذاری مجدد صفحه به حالت اولیه برمی‌گردند.
 * در فاز بعدی (بک‌اند) این بخش با API جایگزین می‌شود.
 */

const TODAY_JALALI = "۱۴۰۵/۰۸/۱۶";

const ORDER_STATUS = {
  waiting: "در انتظار شروع",
  progress: "در حال دوخت",
  ready: "آماده تحویل",
  delivered: "تحویل شده",
};

const ORDER_TYPE = {
  sewing: "دوخت لباس",
  repair: "تعمیرات",
};

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

const orders = [
  { id: "۱۴۰۵-۰۲۱", customer: "مریم احمدی", type: "sewing", desc: "دوخت لباس مجلسی", created: "۱۴۰۵/۰۸/۱۰", due: "۱۴۰۵/۰۸/۱۴", status: "progress", price: 8500000 },
  { id: "۱۴۰۵-۰۲۰", customer: "نگار رضایی", type: "repair", desc: "تعمیر و اصلاح مانتو", created: "۱۴۰۵/۰۸/۰۹", due: "۱۴۰۵/۰۸/۱۲", status: "ready", price: 450000 },
  { id: "۱۴۰۵-۰۱۹", customer: "سارا موسوی", type: "sewing", desc: "دوخت مانتو", created: "۱۴۰۵/۰۸/۰۷", due: "۱۴۰۵/۰۸/۱۵", status: "delivered", price: 6200000 },
  { id: "۱۴۰۵-۰۱۸", customer: "الهام کریمی", type: "repair", desc: "کوتاهی و اصلاح لباس", created: "۱۴۰۵/۰۸/۰۶", due: "۱۴۰۵/۰۸/۱۳", status: "waiting", price: 380000 },
  { id: "۱۴۰۵-۰۱۷", customer: "پریا کاوه", type: "sewing", desc: "دوخت کت و دامن", created: "۱۴۰۵/۰۸/۰۵", due: "۱۴۰۵/۰۸/۱۶", status: "progress", price: 7400000 },
];

const customers = [
  { name: "مریم احمدی", phone: "۰۹۱۲۳۴۵۶۷۸۹", count: 5, last: "۱۴۰۵/۰۸/۱۴", state: "فعال", note: "مشتری دائمی و بسیار خوش‌سلیقه است." },
  { name: "نگار رضایی", phone: "۰۹۳۵۸۷۶۵۴۳۲", count: 7, last: "۱۴۰۵/۰۸/۱۰", state: "VIP", note: "ترجیح می‌دهد قبل از شروع کار، مدل نهایی تأیید شود." },
  { name: "سارا موسوی", phone: "۰۹۱۱۷۶۵۴۳۲۱", count: 2, last: "۱۴۰۵/۰۸/۰۹", state: "معمولی", note: "" },
  { name: "الهام کریمی", phone: "۰۹۸۷۶۵۴۳۲۱", count: 3, last: "۱۴۰۵/۰۸/۰۵", state: "فعال", note: "" },
  { name: "پریا کاوه", phone: "۰۹۳۷۸۹۱۲۳۴۵", count: 4, last: "۱۴۰۵/۰۸/۰۱", state: "معمولی", note: "" },
];

/* ---------- توابع کمکی عددی و امنیتی ---------- */

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

// تبدیل ارقام فارسی/عربی به انگلیسی
function toEnDigits(str) {
  return String(str).replace(/[۰-۹]/g, (d) => FA_DIGITS.indexOf(d))
    .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660);
}

// تبدیل ارقام انگلیسی به فارسی
function toFaDigits(value) {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[+d]);
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
  const max = orders.reduce((m, o) => Math.max(m, parseInt(toEnDigits(o.id).split("-")[1], 10) || 0), 0);
  return "۱۴۰۵-" + toFaDigits(String(max + 1).padStart(3, "0"));
}
