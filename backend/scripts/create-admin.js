/*
 * ساخت مزون و مدیر اولیه.
 * استفاده (گذرواژه از متغیر محیطی خوانده می‌شود تا در تاریخچه‌ی shell نماند):
 *   DATABASE_URL=... ADMIN_PASSWORD='...' node scripts/create-admin.js \
 *     --email admin@example.com --name "فاطمه سعیدی" --shop "مزون دوخت‌یار"
 */
const { createPool } = require('../src/db');
const { hashPassword } = require('../src/auth');

async function createShopAdmin(db, { shopName, email, password, fullName }) {
  const normalized = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('ایمیل معتبر نیست');
  if (!password || password.length < 10) throw new Error('گذرواژه باید حداقل ۱۰ نویسه باشد');
  const hash = await hashPassword(password);
  const shop = await db.query(
    'INSERT INTO shops (name, owner_name) VALUES ($1, $2) RETURNING id', [shopName, fullName]
  );
  const user = await db.query(
    `INSERT INTO users (shop_id, email, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4, 'admin') RETURNING id, email`,
    [shop.rows[0].id, normalized, hash, fullName]
  );
  return { shopId: shop.rows[0].id, userId: user.rows[0].id, email: user.rows[0].email };
}

module.exports = { createShopAdmin };

if (require.main === module) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const db = createPool();
  createShopAdmin(db, {
    shopName: arg('shop') || 'مزون دوخت‌یار',
    email: arg('email'),
    fullName: arg('name') || 'مدیر',
    password: process.env.ADMIN_PASSWORD,
  })
    .then((r) => console.log(`ایجاد شد: ${r.email}`))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => db.end());
}
