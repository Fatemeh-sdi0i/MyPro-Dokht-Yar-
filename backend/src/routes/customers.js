const { normalizePhone, HttpError, existingOwned, isIdRace } = require('../util');

const CUSTOMER_TIERS = ['regular', 'active', 'vip'];
const idParam = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } };
const VERSION_QUERY = { type: 'object', properties: { version: { type: 'integer', minimum: 1 } } };
const versionConflict = () => new HttpError(409, 'version_conflict', 'این مشتری هم‌زمان تغییر کرده است؛ صفحه را تازه کنید');

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
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (req, reply) => {
    if (req.body.id && await existingOwned(db, 'customers', req.body.id, req.user.shop_id)) {
      reply.code(200);
      const { rows } = await db.query(`${baseSelect} WHERE c.id = $1 AND c.shop_id = $2`, [req.body.id, req.user.shop_id]);
      return customerOut(rows[0]);
    }
    const phone = normalizePhone(req.body.phone);
    if (phone === undefined) throw new HttpError(400, 'invalid_phone', 'شماره‌ی موبایل معتبر نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹)');
    let rows;
    try {
      ({ rows } = await db.query(
        `INSERT INTO customers (id, shop_id, name, phone, note, tier)
         VALUES (COALESCE($6::uuid, gen_random_uuid()), $1, $2, $3, $4, $5) RETURNING id`,
        [req.user.shop_id, req.body.name.trim(), phone, req.body.note || '', req.body.tier || 'regular', req.body.id || null]
      ));
    } catch (err) {
      if (!isIdRace(err, 'customers', req.body.id) || !(await existingOwned(db, 'customers', req.body.id, req.user.shop_id))) throw err;
      reply.code(200);
      const replay = await db.query(`${baseSelect} WHERE c.id = $1 AND c.shop_id = $2`, [req.body.id, req.user.shop_id]);
      return customerOut(replay.rows[0]);
    }
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

  // فهرست مشتری‌های حذف‌شده (برای بازگردانی)؛ پیش از /customers/:id تعریف می‌شود
  app.get('/customers/deleted', async (req) => {
    const { rows } = await db.query(
      `${baseSelect} WHERE c.shop_id = $1 AND c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC LIMIT 500`,
      [req.user.shop_id]
    );
    return { items: rows.map((c) => ({ ...customerOut(c), deleted_at: c.deleted_at })) };
  });

  // حذف نرم: سفارش‌های مشتری حذف نمی‌شوند.
  // اگر version فرستاده شود و با نسخه‌ی فعلی نخواند، ۴۰۹ و بدون تغییر.
  app.delete('/customers/:id', {
    schema: { params: idParam, querystring: VERSION_QUERY },
  }, async (req) => {
    const shopId = req.user.shop_id;
    const id = req.params.id;
    const expected = req.query.version;
    const current = await loadCustomer(db, shopId, id);
    if (expected !== undefined && expected !== current.version) throw versionConflict();
    // شرط نسخه داخل خود UPDATE هم هست تا تغییر هم‌زمان بین بررسی و نوشتن گم نشود
    const { rowCount } = await db.query(
      `UPDATE customers SET deleted_at = now()
        WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL AND ($3::int IS NULL OR version = $3)`,
      [id, shopId, expected ?? null]
    );
    if (rowCount === 0) throw versionConflict();
    return { ok: true };
  });

  // بازگردانی مشتری حذف‌شده. اگر شماره‌ی تماسش اکنون متعلق به مشتری فعال دیگری باشد، ۴۰۹ و بدون تغییر.
  app.post('/customers/:id/restore', { schema: { params: idParam } }, async (req) => {
    const shopId = req.user.shop_id;
    let rows;
    try {
      ({ rows } = await db.query(
        'UPDATE customers SET deleted_at = NULL WHERE id = $1 AND shop_id = $2 AND deleted_at IS NOT NULL RETURNING id',
        [req.params.id, shopId]
      ));
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'customers_phone_key') {
        throw new HttpError(409, 'phone_taken', 'این شماره‌ی تماس اکنون برای مشتری دیگری ثبت شده است؛ ابتدا یکی از آن‌ها را تغییر دهید');
      }
      throw err;
    }
    if (!rows[0]) throw new HttpError(404, 'not_found', 'مشتری حذف‌شده‌ای با این شناسه پیدا نشد');
    return customerOut(await loadCustomer(db, shopId, req.params.id));
  });
};
