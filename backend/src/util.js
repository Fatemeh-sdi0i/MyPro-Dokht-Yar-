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

// شناسه‌ی تولیدشده روی کلاینت (برای همگام‌سازی آفلاین):
// اگر همین شناسه از قبل در همین مزون باشد، همان ردیف برمی‌گردد؛ در مزون دیگر 409.
// table فقط از فهرست ثابت فراخوان‌ها می‌آید، نه ورودی کاربر.
const ALLOWED_TABLES = new Set(['customers', 'orders', 'transactions', 'staff']);
async function existingOwned(db, table, id, shopId) {
  if (!ALLOWED_TABLES.has(table)) throw new Error('جدول مجاز نیست');
  const { rows } = await db.query(`SELECT id, shop_id FROM ${table} WHERE id = $1`, [id]);
  if (!rows[0]) return false;
  if (rows[0].shop_id !== shopId) throw new HttpError(409, 'id_taken', 'این شناسه قبلاً استفاده شده است');
  return true;
}

module.exports = { toEnDigits, normalizePhone, isoDate, HttpError, existingOwned };
