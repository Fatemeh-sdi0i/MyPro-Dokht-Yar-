const { Pool, types } = require('pg');

// تاریخ (date) را همان رشته‌ی YYYY-MM-DD برگردان، و bigint را عدد (مبالغ به تومان کوچک‌اند)
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));

function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL تنظیم نشده است');
  return new Pool({ connectionString: url, max: 10 });
}

// اجرای fn داخل تراکنش؛ در خطا ROLLBACK می‌کند
async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withTx };
