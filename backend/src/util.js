const FA = '۰۱۲۳۴۵۶۷۸۹';
const AR = '٠١٢٣٤٥٦٧٨٩';

// ارقام فارسی و عربی را به انگلیسی تبدیل می‌کند
function toEnDigits(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));
}

// شماره‌ی موبایل ایرانی: ۰۹xxxxxxxxx؛ فاصله و خط‌تیره حذف می‌شود
function normalizePhone(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = toEnDigits(value).replace(/[\s\-()]/g, '');
  return /^09\d{9}$/.test(cleaned) ? cleaned : undefined; // undefined = نامعتبر
}

function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

// خطای قابل‌نمایش به کاربر با کد HTTP
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.statusCode = status;
    this.code = code;
  }
}

module.exports = { toEnDigits, normalizePhone, isoDate, HttpError };
