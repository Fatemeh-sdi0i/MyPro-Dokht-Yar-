// خروجی کامل یک مزون (شکل پشتیبان سرور). q می‌تواند pool یا client تراکنش باشد؛ هر دو query دارند.
// ردیف‌های حذف‌نرم‌شده هم هستند تا بازگردانی تاریخچه‌ی مالی و مشتری را کامل نگه دارد؛ نمایش‌ها آن‌ها را فیلتر می‌کنند.
async function buildExport(q, shopId) {
  const [shop, customers, orders, staff, transactions, statusLog] = await Promise.all([
    q.query('SELECT * FROM shops WHERE id=$1', [shopId]),
    q.query('SELECT id,name,phone,note,tier,deleted_at FROM customers WHERE shop_id=$1 ORDER BY name, id', [shopId]),
    q.query(`SELECT o.id, o.order_no, o.customer_id, c.name AS customer, o.type, o.description, o.status, o.price,
                    o.created_on, o.due_on, o.deleted_at
               FROM orders o JOIN customers c ON c.id = o.customer_id
              WHERE o.shop_id = $1 ORDER BY o.order_no, o.id`, [shopId]),
    q.query('SELECT id,name,role_title,phone,active,deleted_at FROM staff WHERE shop_id=$1 ORDER BY name, id', [shopId]),
    q.query('SELECT id,kind,category,amount,occurred_on,note,deleted_at FROM transactions WHERE shop_id=$1 ORDER BY occurred_on, id', [shopId]),
    q.query(`SELECT l.order_id, l.from_status, l.to_status, l.changed_at
               FROM order_status_log l JOIN orders o ON o.id = l.order_id
              WHERE o.shop_id = $1 ORDER BY l.changed_at, l.id`, [shopId]),
  ]);
  const s = shop.rows[0];
  if (!s) throw new Error('مزون پیدا نشد');
  return {
    exported_at: new Date().toISOString(),
    shop: { shop_name: s.name, owner_name: s.owner_name, phone: s.phone, address: s.address, currency: s.currency },
    customers: customers.rows,
    orders: orders.rows,
    staff: staff.rows,
    transactions: transactions.rows,
    status_log: statusLog.rows,
  };
}

module.exports = { buildExport };
