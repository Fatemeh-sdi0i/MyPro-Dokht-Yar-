const { withTx } = require('../db');
const { isoDate, HttpError, existingOwned, isIdRace } = require('../util');

const ORDER_TYPES = ['sewing', 'repair'];
const ORDER_STATUSES = ['waiting', 'progress', 'ready', 'delivered'];

const orderOut = (o) => ({
  id: o.id, order_no: o.order_no, customer_id: o.customer_id, customer_name: o.customer_name,
  type: o.type, description: o.description, status: o.status, price: o.price,
  created_on: o.created_on, due_on: o.due_on, version: o.version, updated_at: o.updated_at,
});

const baseSelect = `
  SELECT o.*, c.name AS customer_name
    FROM orders o JOIN customers c ON c.id = o.customer_id`;

async function loadOrder(db, shopId, id) {
  const { rows } = await db.query(
    `${baseSelect} WHERE o.id = $1 AND o.shop_id = $2 AND o.deleted_at IS NULL`, [id, shopId]
  );
  if (!rows[0]) throw new HttpError(404, 'not_found', 'سفارش پیدا نشد');
  return rows[0];
}

const idParam = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } };

module.exports = async function ordersRoutes(app, { db }) {
  app.get('/orders', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ORDER_STATUSES },
          type: { type: 'string', enum: ORDER_TYPES },
          q: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (req) => {
    const { status = null, type = null } = req.query;
    const q = (req.query.q || '').trim();
    const { rows } = await db.query(
      `${baseSelect}
        WHERE o.shop_id = $1 AND o.deleted_at IS NULL
          AND ($2::text IS NULL OR o.status = $2::order_status)
          AND ($3::text IS NULL OR o.type = $3::order_type)
          AND ($4 = '' OR o.description ILIKE '%' || $4 || '%' OR c.name ILIKE '%' || $4 || '%' OR o.order_no::text = $4)
        ORDER BY o.order_no DESC LIMIT 500`,
      [req.user.shop_id, status, type, q]
    );
    return { items: rows.map(orderOut) };
  });

  app.post('/orders', {
    schema: {
      body: {
        type: 'object',
        required: ['customer_id', 'type', 'description'],
        additionalProperties: false,
        properties: {
          customer_id: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ORDER_TYPES },
          description: { type: 'string', minLength: 1, maxLength: 500 },
          price: { type: 'integer', minimum: 0, maximum: 1000000000000 },
          due_on: { type: ['string', 'null'] },
          status: { type: 'string', enum: ORDER_STATUSES },
          // فقط برای انتقال داده‌های قبلی (مدیر): شماره و تاریخ ایجاد اصلی
          order_no: { type: 'integer', minimum: 1, maximum: 1000000000 },
          created_on: { type: 'string' },
          id: { type: 'string', format: 'uuid' },
        },
      },
      // اعتبارسنجی نقش در preHandler انجام می‌شود (پیام فارسی یکسان با بقیه‌ی مسیرها)
    },
    preHandler: async (req) => {
      const importing = req.body && (req.body.order_no !== undefined || req.body.created_on !== undefined);
      if (importing && req.user.role !== 'admin') {
        throw new HttpError(403, 'forbidden', 'این کار فقط برای مدیر مجاز است');
      }
    },
  }, async (req, reply) => {
    const due = isoDate(req.body.due_on);
    if (due === undefined) throw new HttpError(400, 'invalid_date', 'تاریخ تحویل باید به شکل YYYY-MM-DD باشد');
    const created = req.body.created_on === undefined ? null : isoDate(req.body.created_on);
    if (created === undefined) throw new HttpError(400, 'invalid_date', 'تاریخ ایجاد باید به شکل YYYY-MM-DD باشد');
    const shopId = req.user.shop_id;
    if (req.body.id && await existingOwned(db, 'orders', req.body.id, shopId)) {
      // تکرار ارسال همان عملیات آفلاین: همان سفارش برمی‌گردد و شماره‌ی تازه مصرف نمی‌شود
      reply.code(200);
      const { rows } = await db.query(`${baseSelect} WHERE o.id = $1 AND o.shop_id = $2`, [req.body.id, shopId]);
      return orderOut(rows[0]);
    }

    const id = await withTx(db, async (tx) => {
      // قفل روی مزون: شماره‌ی سفارش بدون تکرار و بدون رقابت بین درخواست‌های هم‌زمان
      await tx.query('SELECT id FROM shops WHERE id = $1 FOR UPDATE', [shopId]);
      const cust = await tx.query(
        'SELECT id FROM customers WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL', [req.body.customer_id, shopId]
      );
      if (!cust.rows[0]) throw new HttpError(400, 'customer_not_found', 'مشتری پیدا نشد');
      // شماره‌ی صریح فقط در انتقال داده (مدیر) داده می‌شود؛ تکرار با قید یکتایی پایگاه داده رد می‌شود
      let orderNo = req.body.order_no;
      if (orderNo === undefined) {
        const next = await tx.query('SELECT COALESCE(MAX(order_no), 0) + 1 AS n FROM orders WHERE shop_id = $1', [shopId]);
        orderNo = next.rows[0].n;
      }
      const status = req.body.status || 'waiting';
      const ins = await tx.query(
        `INSERT INTO orders (id, shop_id, order_no, customer_id, type, description, status, price, due_on, created_on)
         VALUES (COALESCE($10::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, current_date)) RETURNING id`,
        [shopId, orderNo, req.body.customer_id, req.body.type, req.body.description.trim(),
          status, req.body.price || 0, due, created, req.body.id || null]
      );
      await tx.query(
        'INSERT INTO order_status_log (order_id, from_status, to_status, changed_by) VALUES ($1, NULL, $2, $3)',
        [ins.rows[0].id, status, req.user.id]
      );
      return ins.rows[0].id;
    }).catch(async (err) => {
      // هم‌زمانی روی همان شناسه: ردیف توسط درخواست دیگری ساخته شده؛ همان را برمی‌گردانیم
      if (!isIdRace(err, 'orders', req.body.id) || !(await existingOwned(db, 'orders', req.body.id, shopId))) throw err;
      return null;
    });
    if (id === null) {
      reply.code(200);
      const { rows } = await db.query(`${baseSelect} WHERE o.id = $1 AND o.shop_id = $2`, [req.body.id, shopId]);
      return orderOut(rows[0]);
    }
    reply.code(201);
    return orderOut(await loadOrder(db, shopId, id));
  });

  app.get('/orders/:id', { schema: { params: idParam } },
    async (req) => orderOut(await loadOrder(db, req.user.shop_id, req.params.id)));

  app.patch('/orders/:id', {
    schema: {
      params: idParam,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ORDER_TYPES },
          description: { type: 'string', minLength: 1, maxLength: 500 },
          price: { type: 'integer', minimum: 0, maximum: 1000000000000 },
          due_on: { type: ['string', 'null'] },
          version: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req) => {
    const current = await loadOrder(db, req.user.shop_id, req.params.id);
    if (req.body.version !== undefined && req.body.version !== current.version) {
      throw new HttpError(409, 'version_conflict', 'این سفارش هم‌زمان تغییر کرده است؛ صفحه را تازه کنید');
    }
    const sets = [];
    const vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (req.body.type !== undefined) add('type', req.body.type);
    if (req.body.description !== undefined) add('description', req.body.description.trim());
    if (req.body.price !== undefined) add('price', req.body.price);
    if (req.body.due_on !== undefined) {
      const due = isoDate(req.body.due_on);
      if (due === undefined) throw new HttpError(400, 'invalid_date', 'تاریخ تحویل معتبر نیست');
      add('due_on', due);
    }
    if (sets.length) {
      vals.push(req.params.id, req.user.shop_id);
      await db.query(
        `UPDATE orders SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND shop_id = $${vals.length}`, vals
      );
    }
    return orderOut(await loadOrder(db, req.user.shop_id, req.params.id));
  });

  // تغییر وضعیت: در همان تراکنش، تاریخچه ثبت می‌شود
  app.post('/orders/:id/status', {
    schema: {
      params: idParam,
      body: {
        type: 'object',
        // نسخه‌ی سفارشی که کلاینت دیده است الزامی است؛ اگر سفارش جلوتر باشد، ۴۰۹ می‌دهیم و چیزی را بازنویسی نمی‌کنیم
        required: ['to', 'version'],
        additionalProperties: false,
        properties: {
          to: { type: 'string', enum: ORDER_STATUSES },
          version: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req) => {
    const shopId = req.user.shop_id;
    await withTx(db, async (tx) => {
      const { rows } = await tx.query(
        'SELECT id, status, version FROM orders WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL FOR UPDATE',
        [req.params.id, shopId]
      );
      const order = rows[0];
      if (!order) throw new HttpError(404, 'not_found', 'سفارش پیدا نشد');
      if (req.body.version !== undefined && req.body.version !== order.version) {
        throw new HttpError(409, 'version_conflict', 'وضعیت این سفارش هم‌زمان تغییر کرده است');
      }
      if (order.status === req.body.to) return;
      await tx.query('UPDATE orders SET status = $1 WHERE id = $2', [req.body.to, order.id]);
      await tx.query(
        'INSERT INTO order_status_log (order_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)',
        [order.id, order.status, req.body.to, req.user.id]
      );
    });
    return orderOut(await loadOrder(db, shopId, req.params.id));
  });

  app.delete('/orders/:id', { schema: { params: idParam } }, async (req) => {
    await loadOrder(db, req.user.shop_id, req.params.id);
    await db.query('UPDATE orders SET deleted_at = now() WHERE id = $1 AND shop_id = $2',
      [req.params.id, req.user.shop_id]);
    return { ok: true };
  });
};
