// اعتبارسنجی کامل پشتیبان سرور پیش از هر تغییر در پایگاه داده.
// ماژول خالص است (بدون وابستگی و بدون پایگاه داده) تا در CI واحد و محلی آزمون شود.
// هر خطا جمع می‌شود؛ اگر چیزی نامعتبر باشد هیچ‌چیز اعمال نمی‌شود.
const { normalizePhone, isoDate, HttpError } = require('./util');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 20000;
const MAX_ERRORS = 25;
const ORDER_TYPES = ['sewing', 'repair'];
const ORDER_STATUSES = ['waiting', 'progress', 'ready', 'delivered'];
const TIERS = ['regular', 'active', 'vip'];
const KINDS = ['income', 'expense'];

class Collector {
  constructor() { this.messages = []; this.count = 0; }
  add(where, text) {
    this.count += 1;
    if (this.messages.length < MAX_ERRORS) this.messages.push(`${where}: ${text}`);
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

function text(c, where, value, { min = 0, max, required = false, field }) {
  if (value === undefined || value === null) {
    if (required) c.add(where, `«${field}» لازم است`);
    return '';
  }
  if (typeof value !== 'string') { c.add(where, `«${field}» باید متن باشد`); return ''; }
  const t = value.trim();
  if (t.length < min) { c.add(where, `«${field}» خالی است`); return ''; }
  if (max !== undefined && [...t].length > max) { c.add(where, `«${field}» بیش از ${max} نویسه است`); return ''; }
  return t;
}

function oneOf(c, where, value, allowed, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) { c.add(where, `مقدار «${field}» نامعتبر است`); return fallback; }
  return value;
}

function uuid(c, where, value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) { c.add(where, `«${field}» شناسه‌ی معتبر نیست`); return null; }
  return value.toLowerCase();
}

function wholeNumber(c, where, value, { min, max, field }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    c.add(where, `«${field}» باید عدد صحیح بین ${min} و ${max} باشد`);
    return min;
  }
  return value;
}

function date(c, where, value, { required, field }) {
  if (value === undefined || value === null || value === '') {
    if (required) c.add(where, `«${field}» لازم است`);
    return null;
  }
  const d = isoDate(value);
  // Date.parse روزهای ناموجود مثل ۳۱ فوریه را به ماه بعد می‌برد؛ پس باید برگشتِ تاریخ هم یکی باشد
  const back = d && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) ? new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) : null;
  if (!d || back !== d) { c.add(where, `«${field}» تاریخ معتبر نیست`); return null; }
  return d;
}

function timestamp(c, where, value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) { c.add(where, `«${field}» زمان معتبر نیست`); return null; }
  return value;
}

function rows(c, name, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { c.add(name, 'باید فهرست باشد'); return []; }
  if (value.length > MAX_ROWS) { c.add(name, `بیش از ${MAX_ROWS} ردیف`); return []; }
  return value;
}

function unique(c, where, values, field) {
  const seen = new Set();
  for (const v of values) {
    if (v === null) continue;
    if (seen.has(v)) c.add(where, `«${field}» تکراری است: ${v}`);
    seen.add(v);
  }
}

/**
 * body: پشتیبان سرور (شکل GET /export، با status_log اختیاری).
 * خروجی: داده‌ی نرمال‌شده برای درج؛ در خطا HttpError(400, 'invalid_backup').
 */
function validateBackup(body) {
  const c = new Collector();
  if (!isObj(body)) throw new HttpError(400, 'invalid_backup', 'فایل پشتیبان نامعتبر است: ساختار شناخته نشد');

  // ---- مزون ----
  const sh = body.shop;
  let shop = null;
  if (!isObj(sh)) {
    c.add('مزون', 'بخش مزون لازم است');
  } else {
    shop = {
      name: text(c, 'مزون', sh.shop_name, { min: 1, max: 120, required: true, field: 'نام مزون' }),
      owner_name: text(c, 'مزون', sh.owner_name ?? '', { max: 120, field: 'نام مدیر' }),
      phone: '',
      address: text(c, 'مزون', sh.address ?? '', { max: 300, field: 'نشانی' }),
      currency: text(c, 'مزون', sh.currency ?? 'تومان', { min: 1, max: 20, field: 'واحد پول' }) || 'تومان',
    };
    if (sh.phone !== undefined && sh.phone !== null && sh.phone !== '') {
      const p = normalizePhone(sh.phone);
      if (p === undefined) c.add('مزون', 'شماره‌ی تماس مزون نامعتبر است'); else shop.phone = p || '';
    }
  }

  // ---- مشتری‌ها ----
  const customerIds = new Set();
  const activePhones = [];
  const customersIn = rows(c, 'customers', body.customers);
  const customers = customersIn.map((r, i) => {
    const where = `مشتری ${i + 1}`;
    if (!isObj(r)) { c.add(where, 'ردیف نامعتبر است'); return null; }
    const id = uuid(c, where, r.id, 'شناسه');
    const name = text(c, where, r.name, { min: 1, max: 120, required: true, field: 'نام' });
    let phone = null;
    if (r.phone !== undefined && r.phone !== null && r.phone !== '') {
      const p = normalizePhone(r.phone);
      if (p === undefined) c.add(where, 'شماره‌ی تماس نامعتبر است'); else phone = p;
    }
    const deletedAt = timestamp(c, where, r.deleted_at, 'حذف شده در');
    if (phone && !deletedAt) activePhones.push(phone);
    const row = {
      id, name, phone, note: text(c, where, r.note ?? '', { max: 2000, field: 'یادداشت' }),
      tier: oneOf(c, where, r.tier, TIERS, 'سطح', 'regular'), deleted_at: deletedAt,
    };
    if (id) customerIds.add(id);
    return row;
  }).filter(Boolean);
  unique(c, 'مشتری‌ها', customers.map((x) => x.id), 'شناسه');
  unique(c, 'مشتری‌ها', activePhones, 'شماره‌ی تماس فعال');

  // ---- همکاران ----
  const staff = rows(c, 'staff', body.staff).map((r, i) => {
    const where = `همکار ${i + 1}`;
    if (!isObj(r)) { c.add(where, 'ردیف نامعتبر است'); return null; }
    let phone = null;
    if (r.phone !== undefined && r.phone !== null && r.phone !== '') {
      const p = normalizePhone(r.phone);
      if (p === undefined) c.add(where, 'شماره‌ی تماس نامعتبر است'); else phone = p;
    }
    return {
      id: uuid(c, where, r.id, 'شناسه'),
      name: text(c, where, r.name, { min: 1, max: 120, required: true, field: 'نام' }),
      role_title: text(c, where, r.role_title ?? '', { max: 120, field: 'سمت' }),
      phone,
      active: r.active === undefined ? true : (typeof r.active === 'boolean' ? r.active : (c.add(where, '«فعال» باید درست/نادرست باشد'), true)),
      deleted_at: timestamp(c, where, r.deleted_at, 'حذف شده در'),
    };
  }).filter(Boolean);
  unique(c, 'همکاران', staff.map((x) => x.id), 'شناسه');

  // ---- سفارش‌ها ----
  const orderIds = new Set();
  const orderNos = [];
  const orders = rows(c, 'orders', body.orders).map((r, i) => {
    const where = `سفارش ${i + 1}`;
    if (!isObj(r)) { c.add(where, 'ردیف نامعتبر است'); return null; }
    const id = uuid(c, where, r.id, 'شناسه');
    let customerId = null;
    if (r.customer_id !== undefined && r.customer_id !== null) {
      customerId = uuid(c, where, r.customer_id, 'شناسه‌ی مشتری');
    } else {
      // پشتیبان‌های قدیمی بدون customer_id: فقط اگر نام مشتری در فایل یکتا باشد
      const name = text(c, where, r.customer ?? '', { min: 1, max: 120, field: 'مشتری' });
      const matches = customersIn.filter((x) => isObj(x) && typeof x.name === 'string' && x.name.trim() === name);
      if (matches.length === 1 && isObj(matches[0])) customerId = str(matches[0].id)?.toLowerCase() ?? null;
      else c.add(where, 'مشتری این سفارش در فایل یکتا پیدا نشد');
    }
    if (customerId && !customerIds.has(customerId)) c.add(where, 'مشتری این سفارش در فایل نیست');
    const orderNo = wholeNumber(c, where, r.order_no, { min: 1, max: 2147483647, field: 'شماره‌ی سفارش' });
    orderNos.push(orderNo);
    return {
      id,
      order_no: orderNo,
      customer_id: customerId,
      type: oneOf(c, where, r.type, ORDER_TYPES, 'نوع', 'sewing'),
      description: text(c, where, r.description, { min: 1, max: 500, required: true, field: 'شرح' }),
      status: oneOf(c, where, r.status, ORDER_STATUSES, 'وضعیت', 'waiting'),
      price: wholeNumber(c, where, r.price ?? 0, { min: 0, max: 1000000000000, field: 'قیمت' }),
      created_on: date(c, where, r.created_on, { required: true, field: 'تاریخ ثبت' }),
      due_on: date(c, where, r.due_on, { required: false, field: 'تاریخ تحویل' }),
      deleted_at: timestamp(c, where, r.deleted_at, 'حذف شده در'),
    };
  }).filter(Boolean);
  orders.forEach((o) => { if (o.id) orderIds.add(o.id); });
  unique(c, 'سفارش‌ها', orders.map((x) => x.id), 'شناسه');
  unique(c, 'سفارش‌ها', orderNos, 'شماره‌ی سفارش');

  // ---- امور مالی ----
  const transactions = rows(c, 'transactions', body.transactions).map((r, i) => {
    const where = `تراکنش ${i + 1}`;
    if (!isObj(r)) { c.add(where, 'ردیف نامعتبر است'); return null; }
    return {
      id: uuid(c, where, r.id, 'شناسه'),
      kind: oneOf(c, where, r.kind, KINDS, 'نوع', 'income'),
      category: text(c, where, r.category, { min: 1, max: 60, required: true, field: 'دسته' }),
      amount: wholeNumber(c, where, r.amount, { min: 1, max: 1000000000000, field: 'مبلغ' }),
      occurred_on: date(c, where, r.occurred_on, { required: true, field: 'تاریخ' }),
      note: text(c, where, r.note ?? '', { max: 500, field: 'یادداشت' }),
      deleted_at: timestamp(c, where, r.deleted_at, 'حذف شده در'),
    };
  }).filter(Boolean);
  unique(c, 'تراکنش‌ها', transactions.map((x) => x.id), 'شناسه');

  // ---- تاریخچه‌ی وضعیت سفارش (اختیاری) ----
  const statusLog = rows(c, 'status_log', body.status_log).map((r, i) => {
    const where = `تاریخچه ${i + 1}`;
    if (!isObj(r)) { c.add(where, 'ردیف نامعتبر است'); return null; }
    const orderId = uuid(c, where, r.order_id, 'شناسه‌ی سفارش');
    if (orderId && !orderIds.has(orderId)) c.add(where, 'سفارش این تاریخچه در فایل نیست');
    return {
      order_id: orderId,
      from_status: r.from_status === null || r.from_status === undefined ? null : oneOf(c, where, r.from_status, ORDER_STATUSES, 'وضعیت قبلی', null),
      to_status: oneOf(c, where, r.to_status, ORDER_STATUSES, 'وضعیت', 'waiting'),
      changed_at: timestamp(c, where, r.changed_at, 'زمان تغییر') || new Date().toISOString(),
    };
  }).filter(Boolean);

  if (c.count > 0) {
    const more = c.count > c.messages.length ? `؛ و ${c.count - c.messages.length} مورد دیگر` : '';
    throw new HttpError(400, 'invalid_backup', `فایل پشتیبان نامعتبر است: ${c.messages.join('؛ ')}${more}`);
  }
  return { shop, customers, staff, orders, transactions, statusLog };
}

module.exports = { validateBackup, MAX_ROWS };
