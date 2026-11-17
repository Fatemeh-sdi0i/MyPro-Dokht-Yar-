const { normalizePhone, HttpError } = require('../util');

const CUSTOMER_TIERS = ['regular', 'active', 'vip'];

const customerOut = (c) => ({
  id: c.id, name: c.name, phone: c.phone, note: c.note, tier: c.tier,
  order_count: Number(c.order_count || 0), created_at: c.created_at, updated_at: c.updated_at, version: c.version,
});

const baseSelect = `
  SELECT c.*, (SELECT count(*) FROM orders o WHERE o.customer_id = c.id AND o.deleted_at IS NULL) AS order_count
    FROM customers c`;

async function loadCustomer(db, shopId, id) {
  const { rows } = await db.query(`${baseSelect} WHERE c.id = $1 AND c.shop_id = $2 AND c.deleted_at IS NULL`, [id, shopId]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'مشتری پیدا نشد');
  return rows[0];
}

module.exports = async function customersRoutes(app, { db }) {
  app.get('/customers', {
    schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 100 } } } },
  }, async (req) => {
    const q = (req.query.q || '').trim();
    const { rows } = await db.query(
      `${baseSelect}
        WHERE c.shop_id = $1 AND c.deleted_at IS NULL
          AND ($2 = '' OR c.name ILIKE '%' || $2 || '%' OR c.phone LIKE '%' || $2 || '%')
        ORDER BY c.name LIMIT 500`,
      [req.user.shop_id, q]
    );
    return { items: rows.map(customerOut) };
  });

  app.post('/customers', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          phone: { type: ['string', 'null'], maxLength: 30 },
          note: { type: 'string', maxLength: 2000 },
          tier: { type: 'string', enum: CUSTOMER_TIERS },
        },
      },
    },
  }, async (req, reply) => {
    const phone = normalizePhone(req.body.phone);
    if (phone === undefined) throw new HttpError(400, 'invalid_phone', 'شماره‌ی موبایل معتبر نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)');
    const { rows } = await db.query(
      `INSERT INTO customers (shop_id, name, phone, note, tier)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.shop_id, req.body.name.trim(), phone, req.body.note || '', req.body.tier || 'regular']
    );
    reply.code(201);
    return customerOut(await loadCustomer(db, req.user.shop_id, rows[0].id));
  });

  app.get('/customers/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => customerOut(await loadCustomer(db, req.user.shop_id, req.params.id)));

  app.patch('/customers/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          phone: { type: ['string', 'null'], maxLength: 30 },
          note: { type: 'string', maxLength: 2000 },
          tier: { type: 'string', enum: CUSTOMER_TIERS },
          version: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req) => {
    const current = await loadCustomer(db, req.user.shop_id, req.params.id);
    if (req.body.version !== undefined && req.body.version !== current.version) {
      throw new HttpError(409, 'version_conflict', 'این مشتری هم‌زمان تغییر کرده است؛ صفحه را تازه کنید');
    }
    const sets = [];
    const vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (req.body.name !== undefined) add('name', req.body.name.trim());
    if (req.body.note !== undefined) add('note', req.body.note);
    if (req.body.tier !== undefined) add('tier', req.body.tier);
    if (req.body.phone !== undefined) {
      const phone = normalizePhone(req.body.phone);
      if (phone === undefined) throw new HttpError(400, 'invalid_phone', 'شماره‌ی موبایل معتبر نیست');
      add('phone', phone);
    }
    if (sets.length) {
      vals.push(req.params.id, req.user.shop_id);
      await db.query(
        `UPDATE customers SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND shop_id = $${vals.length}`,
        vals
      );
    }
    return customerOut(await loadCustomer(db, req.user.shop_id, req.params.id));
  });

  // حذف نرم: سفارش‌های مشتری حذف نمی‌شوند
  app.delete('/customers/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => {
    await loadCustomer(db, req.user.shop_id, req.params.id);
    await db.query(
      'UPDATE customers SET deleted_at = now() WHERE id = $1 AND shop_id = $2',
      [req.params.id, req.user.shop_id]
    );
    return { ok: true };
  });
};
