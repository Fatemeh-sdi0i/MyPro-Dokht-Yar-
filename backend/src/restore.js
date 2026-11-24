// بازگردانی کامل داده‌ی یک مزون از پشتیبان سرور. ترتیب تضمین‌ها:
//  ۱. پشتیبان کامل اعتبارسنجی می‌شود؛ هر خطا یعنی هیچ تغییری در پایگاه داده نیست.
//  ۲. همه‌ی مراحل بعدی در یک تراکنش‌اند؛ هر خطا ROLLBACK می‌کند و داده‌ی اصلی دست‌نخورده می‌ماند.
//  ۳. قفل ردیف مزون گرفته می‌شود تا نوشتن هم‌زمان دیگری وسط بازگردانی نیفتد.
//  ۴. پیش از جایگزینی، کل داده‌ی فعلی در shop_snapshots ذخیره می‌شود (با تاریخچه‌ی وضعیت سفارش).
const { withTx } = require('./db');
const { buildExport } = require('./export');
const { validateBackup } = require('./backup-validate');
const { HttpError } = require('./util');

async function insertAll(c, shopId, data) {
  for (const r of data.customers) {
    await c.query(
      'INSERT INTO customers (id, shop_id, name, phone, note, tier, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [r.id, shopId, r.name, r.phone, r.note, r.tier, r.deleted_at]
    );
  }
  for (const r of data.staff) {
    await c.query(
      'INSERT INTO staff (id, shop_id, name, role_title, phone, active, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [r.id, shopId, r.name, r.role_title, r.phone, r.active, r.deleted_at]
    );
  }
  for (const r of data.orders) {
    await c.query(
      `INSERT INTO orders (id, shop_id, order_no, customer_id, type, description, status, price, created_on, due_on, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.id, shopId, r.order_no, r.customer_id, r.type, r.description, r.status, r.price, r.created_on, r.due_on, r.deleted_at]
    );
  }
  for (const r of data.transactions) {
    await c.query(
      `INSERT INTO transactions (id, shop_id, kind, category, amount, occurred_on, note, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.id, shopId, r.kind, r.category, r.amount, r.occurred_on, r.note, r.deleted_at]
    );
  }
  for (const r of data.statusLog) {
    await c.query(
      'INSERT INTO order_status_log (order_id, from_status, to_status, changed_at) VALUES ($1,$2,$3,$4)',
      [r.order_id, r.from_status, r.to_status, r.changed_at]
    );
  }
}

/**
 * pool: اتصال پایگاه داده (pg Pool). body: پشتیبان سرور. opts.beforeApply: فقط برای آزمون خطا.
 * خروجی: { snapshot_id, counts }.
 */
async function replaceShopData(pool, shopId, userId, body, opts = {}) {
  const data = validateBackup(body);
  try {
    return await withTx(pool, async (c) => {
      const locked = await c.query('SELECT id FROM shops WHERE id = $1 FOR UPDATE', [shopId]);
      if (!locked.rows[0]) throw new HttpError(404, 'not_found', 'مزون پیدا نشد');

      const current = await buildExport(c, shopId);
      const snap = await c.query(
        'INSERT INTO shop_snapshots (shop_id, created_by, reason, payload) VALUES ($1,$2,$3,$4) RETURNING id',
        [shopId, userId, 'پیش از بازگردانی از فایل', JSON.stringify(current)]
      );
      if (opts.beforeApply) await opts.beforeApply(c);

      // حذف فقط پس از ذخیره‌ی نسخه؛ ترتیب به‌خاطر کلید خارجی: سفارش‌ها پیش از مشتری‌ها
      await c.query('DELETE FROM orders WHERE shop_id = $1', [shopId]);
      await c.query('DELETE FROM transactions WHERE shop_id = $1', [shopId]);
      await c.query('DELETE FROM staff WHERE shop_id = $1', [shopId]);
      await c.query('DELETE FROM customers WHERE shop_id = $1', [shopId]);

      const s = data.shop;
      await c.query(
        'UPDATE shops SET name = $2, owner_name = $3, phone = $4, address = $5, currency = $6 WHERE id = $1',
        [shopId, s.name, s.owner_name, s.phone, s.address, s.currency]
      );
      await insertAll(c, shopId, data);

      return {
        snapshot_id: snap.rows[0].id,
        counts: {
          customers: data.customers.length,
          orders: data.orders.length,
          staff: data.staff.length,
          transactions: data.transactions.length,
        },
      };
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // شناسه‌ی یک ردیف قبلاً برای مزون دیگری است؛ تراکنش برگشته و داده‌ی این مزون دست‌نخورده است
    if (err.code === '23505' || err.code === '23503') {
      throw new HttpError(409, 'id_taken', 'یکی از شناسه‌های این فایل قبلاً در مزون دیگری استفاده شده است؛ هیچ داده‌ای تغییر نکرد.');
    }
    throw err;
  }
}

module.exports = { replaceShopData };
