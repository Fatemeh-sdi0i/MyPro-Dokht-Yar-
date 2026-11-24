const { normalizePhone, isoDate, HttpError, existingOwned, isIdRace } = require('../util');
const { buildExport } = require('../export');
const { replaceShopData } = require('../restore');

const requireAdmin = async (req) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'این کار فقط برای مدیر مجاز است');
};
const idParam = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } };

module.exports = async function businessRoutes(app, { db }) {
  // ---------- همکاران ----------
  const staffOut = (s) => ({ id: s.id, name: s.name, role_title: s.role_title, phone: s.phone, active: s.active, version: s.version });
  async function loadStaff(shopId, id) {
    const { rows } = await db.query('SELECT * FROM staff WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL', [id, shopId]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'همکار پیدا نشد');
    return rows[0];
  }

  app.get('/staff', async (req) => {
    const { rows } = await db.query(
      'SELECT * FROM staff WHERE shop_id = $1 AND deleted_at IS NULL ORDER BY active DESC, name', [req.user.shop_id]
    );
    return { items: rows.map(staffOut) };
  });

  app.post('/staff', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object', required: ['name'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          role_title: { type: 'string', maxLength: 120 },
          phone: { type: ['string', 'null'], maxLength: 30 },
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (req, reply) => {
    if (req.body.id && await existingOwned(db, 'staff', req.body.id, req.user.shop_id)) {
      reply.code(200);
      const { rows } = await db.query('SELECT * FROM staff WHERE id = $1 AND shop_id = $2', [req.body.id, req.user.shop_id]);
      return staffOut(rows[0]);
    }
    const phone = normalizePhone(req.body.phone);
    if (phone === undefined) throw new HttpError(400, 'invalid_phone', 'شماره‌ی موبایل معتبر نیست');
    let rows;
    try {
      ({ rows } = await db.query(
        'INSERT INTO staff (id, shop_id, name, role_title, phone) VALUES (COALESCE($5::uuid, gen_random_uuid()), $1, $2, $3, $4) RETURNING *',
        [req.user.shop_id, req.body.name.trim(), req.body.role_title || '', phone, req.body.id || null]
      ));
    } catch (err) {
      if (!isIdRace(err, 'staff', req.body.id) || !(await existingOwned(db, 'staff', req.body.id, req.user.shop_id))) throw err;
      reply.code(200);
      const replay = await db.query('SELECT * FROM staff WHERE id = $1 AND shop_id = $2', [req.body.id, req.user.shop_id]);
      return staffOut(replay.rows[0]);
    }
    reply.code(201);
    return staffOut(rows[0]);
  });

  app.patch('/staff/:id', {
    preHandler: requireAdmin,
    schema: {
      params: idParam,
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          role_title: { type: 'string', maxLength: 120 },
          phone: { type: ['string', 'null'], maxLength: 30 },
          active: { type: 'boolean' },
          version: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req) => {
    const current = await loadStaff(req.user.shop_id, req.params.id);
    if (req.body.version !== undefined && req.body.version !== current.version) {
      throw new HttpError(409, 'version_conflict', 'این همکار هم‌زمان تغییر کرده است');
    }
    const b = req.body;
    const phone = b.phone !== undefined ? normalizePhone(b.phone) : undefined;
    if (phone === undefined && b.phone !== undefined) throw new HttpError(400, 'invalid_phone', 'شماره‌ی موبایل معتبر نیست');
    const { rows } = await db.query(
      `UPDATE staff SET
         name = COALESCE($3, name),
         role_title = COALESCE($4, role_title),
         phone = CASE WHEN $5::boolean THEN $6 ELSE phone END,
         active = COALESCE($7, active)
       WHERE id = $1 AND shop_id = $2 RETURNING *`,
      [req.params.id, req.user.shop_id, b.name?.trim() ?? null, b.role_title ?? null,
        b.phone !== undefined, phone ?? null, b.active ?? null]
    );
    return staffOut(rows[0]);
  });

  app.delete('/staff/:id', { preHandler: requireAdmin, schema: { params: idParam } }, async (req) => {
    await loadStaff(req.user.shop_id, req.params.id);
    await db.query('UPDATE staff SET deleted_at = now() WHERE id = $1 AND shop_id = $2', [req.params.id, req.user.shop_id]);
    return { ok: true };
  });

  // ---------- امور مالی ----------
  const txOut = (t) => ({
    id: t.id, kind: t.kind, category: t.category, amount: t.amount,
    occurred_on: t.occurred_on, note: t.note, version: t.version,
  });

  app.get('/transactions', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['income', 'expense'] },
          from: { type: 'string' }, to: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const from = isoDate(req.query.from) ?? null;
    const to = isoDate(req.query.to) ?? null;
    const { rows } = await db.query(
      `SELECT * FROM transactions
        WHERE shop_id = $1 AND deleted_at IS NULL
          AND ($2::text IS NULL OR kind = $2::transaction_kind)
          AND ($3::date IS NULL OR occurred_on >= $3::date)
          AND ($4::date IS NULL OR occurred_on <= $4::date)
        ORDER BY occurred_on DESC, created_at DESC LIMIT 1000`,
      [req.user.shop_id, req.query.kind ?? null, from, to]
    );
    return { items: rows.map(txOut) };
  });

  app.post('/transactions', {
    schema: {
      body: {
        type: 'object', required: ['kind', 'category', 'amount'], additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['income', 'expense'] },
          category: { type: 'string', minLength: 1, maxLength: 60 },
          amount: { type: 'integer', minimum: 1, maximum: 1000000000000 },
          occurred_on: { type: ['string', 'null'] },
          note: { type: 'string', maxLength: 500 },
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (req, reply) => {
    if (req.body.id && await existingOwned(db, 'transactions', req.body.id, req.user.shop_id)) {
      reply.code(200);
      const { rows } = await db.query('SELECT * FROM transactions WHERE id = $1 AND shop_id = $2', [req.body.id, req.user.shop_id]);
      return txOut(rows[0]);
    }
    const day = isoDate(req.body.occurred_on);
    if (day === undefined) throw new HttpError(400, 'invalid_date', 'تاریخ معتبر نیست');
    let rows;
    try {
      ({ rows } = await db.query(
        `INSERT INTO transactions (id, shop_id, kind, category, amount, occurred_on, note, created_by)
         VALUES (COALESCE($8::uuid, gen_random_uuid()), $1, $2, $3, $4, COALESCE($5::date, current_date), $6, $7) RETURNING *`,
        [req.user.shop_id, req.body.kind, req.body.category.trim(), req.body.amount, day, req.body.note || '', req.user.id, req.body.id || null]
      ));
    } catch (err) {
      if (!isIdRace(err, 'transactions', req.body.id) || !(await existingOwned(db, 'transactions', req.body.id, req.user.shop_id))) throw err;
      reply.code(200);
      const replay = await db.query('SELECT * FROM transactions WHERE id = $1 AND shop_id = $2', [req.body.id, req.user.shop_id]);
      return txOut(replay.rows[0]);
    }
    reply.code(201);
    return txOut(rows[0]);
  });

  app.delete('/transactions/:id', { schema: { params: idParam } }, async (req) => {
    const { rowCount } = await db.query(
      'UPDATE transactions SET deleted_at = now() WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL',
      [req.params.id, req.user.shop_id]
    );
    if (!rowCount) throw new HttpError(404, 'not_found', 'تراکنش پیدا نشد');
    return { ok: true };
  });

  // تراکنش‌های حذف‌شده (حذف نرم): فهرست برای بازگردانی
  app.get('/transactions/deleted', async (req) => {
    const { rows } = await db.query(
      `SELECT * FROM transactions WHERE shop_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500`,
      [req.user.shop_id]
    );
    return { items: rows.map((t) => ({ ...txOut(t), deleted_at: t.deleted_at })) };
  });

  app.post('/transactions/:id/restore', { schema: { params: idParam } }, async (req) => {
    const { rows } = await db.query(
      'UPDATE transactions SET deleted_at = NULL WHERE id = $1 AND shop_id = $2 AND deleted_at IS NOT NULL RETURNING *',
      [req.params.id, req.user.shop_id]
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'تراکنش حذف‌شده پیدا نشد');
    return txOut(rows[0]);
  });

  // ---------- گزارش‌ها ----------
  app.get('/reports/summary', async (req) => {
    const shopId = req.user.shop_id;
    const [byStatus, byType, money, top] = await Promise.all([
      db.query(`SELECT status, count(*)::int AS n FROM orders WHERE shop_id=$1 AND deleted_at IS NULL GROUP BY status`, [shopId]),
      db.query(`SELECT type, count(*)::int AS n FROM orders WHERE shop_id=$1 AND deleted_at IS NULL GROUP BY type`, [shopId]),
      db.query(
        `SELECT
           COALESCE((SELECT sum(price) FROM orders WHERE shop_id=$1 AND deleted_at IS NULL AND status='delivered'), 0) AS order_income,
           COALESCE((SELECT sum(amount) FROM transactions WHERE shop_id=$1 AND deleted_at IS NULL AND kind='income'), 0) AS other_income,
           COALESCE((SELECT sum(amount) FROM transactions WHERE shop_id=$1 AND deleted_at IS NULL AND kind='expense'), 0) AS expense`,
        [shopId]
      ),
      db.query(
        `SELECT c.name, count(*)::int AS orders FROM orders o JOIN customers c ON c.id=o.customer_id
          WHERE o.shop_id=$1 AND o.deleted_at IS NULL GROUP BY c.name ORDER BY orders DESC, c.name LIMIT 5`,
        [shopId]
      ),
    ]);
    const statuses = Object.fromEntries(['waiting', 'progress', 'ready', 'delivered'].map((k) => [k, 0]));
    byStatus.rows.forEach((r) => { statuses[r.status] = r.n; });
    const types = Object.fromEntries(['sewing', 'repair'].map((k) => [k, 0]));
    byType.rows.forEach((r) => { types[r.type] = r.n; });
    const m = money.rows[0];
    const delivered = statuses.delivered;
    const orderIncome = Number(m.order_income);
    const otherIncome = Number(m.other_income);
    const expense = Number(m.expense);
    return {
      orders: { total: Object.values(statuses).reduce((a, b) => a + b, 0), by_status: statuses, by_type: types },
      money: {
        order_income: orderIncome,
        other_income: otherIncome,
        expense,
        balance: orderIncome + otherIncome - expense,
        average_delivered_order: delivered ? Math.round(orderIncome / delivered) : 0,
      },
      top_customers: top.rows,
    };
  });

  // ---------- تنظیمات مزون ----------
  const settingsOut = (s) => ({
    shop_name: s.name, owner_name: s.owner_name, phone: s.phone, address: s.address, currency: s.currency, version: s.version,
  });

  app.get('/settings', async (req) => {
    const { rows } = await db.query('SELECT * FROM shops WHERE id = $1', [req.user.shop_id]);
    return settingsOut(rows[0]);
  });

  app.put('/settings', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          shop_name: { type: 'string', minLength: 1, maxLength: 120 },
          owner_name: { type: 'string', maxLength: 120 },
          phone: { type: ['string', 'null'], maxLength: 30 },
          address: { type: 'string', maxLength: 300 },
          currency: { type: 'string', minLength: 1, maxLength: 20 },
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    const phone = b.phone !== undefined ? normalizePhone(b.phone) : undefined;
    if (b.phone !== undefined && phone === undefined) throw new HttpError(400, 'invalid_phone', 'شماره‌ی موبایل معتبر نیست');
    const { rows } = await db.query(
      `UPDATE shops SET
         name = COALESCE($2, name),
         owner_name = COALESCE($3, owner_name),
         phone = CASE WHEN $4::boolean THEN COALESCE($5, '') ELSE phone END,
         address = COALESCE($6, address),
         currency = COALESCE($7, currency)
       WHERE id = $1 RETURNING *`,
      [req.user.shop_id, b.shop_name?.trim() ?? null, b.owner_name?.trim() ?? null,
        b.phone !== undefined, phone ?? null, b.address ?? null, b.currency?.trim() ?? null]
    );
    return settingsOut(rows[0]);
  });

  // ---------- پشتیبان JSON (فقط مدیر) ----------
  app.get('/export', { preHandler: requireAdmin }, async (req) => buildExport(db, req.user.shop_id));

  // ---------- بازگردانی کامل از پشتیبان سرور (فقط مدیر) ----------
  // پشتیبان کامل اعتبارسنجی، سپس نسخه‌ی پیش از بازگردانی ذخیره، و جایگزینی در یک تراکنش (backend/src/restore.js)
  app.post('/import/replace', { preHandler: requireAdmin, bodyLimit: 20 * 1024 * 1024 }, async (req) =>
    replaceShopData(db, req.user.shop_id, req.user.id, req.body)
  );

  app.get('/import/snapshots', { preHandler: requireAdmin }, async (req) => {
    const { rows } = await db.query(
      `SELECT id, created_at, reason,
              jsonb_array_length(payload->'customers') AS customers,
              jsonb_array_length(payload->'orders') AS orders,
              jsonb_array_length(payload->'staff') AS staff,
              jsonb_array_length(payload->'transactions') AS transactions
         FROM shop_snapshots WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.shop_id]
    );
    return { items: rows };
  });

  // خود نسخه به همان شکل پشتیبان برمی‌گردد تا بتوان آن را دوباره بازگرداند
  app.get('/import/snapshots/:id', { preHandler: requireAdmin, schema: { params: idParam } }, async (req) => {
    const { rows } = await db.query('SELECT payload FROM shop_snapshots WHERE id = $1 AND shop_id = $2', [req.params.id, req.user.shop_id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'نسخه پیدا نشد');
    return rows[0].payload;
  });
};
