const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError } = require('./util');

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SESSION_DAYS = 30;

// هش گذرواژه با scrypt داخلی Node (بدون وابستگی بومی)
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// هش ثابت برای مقایسه‌ی هم‌زمان وقتی ایمیل وجود ندارد (جلوگیری از حدس ایمیل از روی زمان پاسخ)
const DUMMY_HASH = ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P,
  Buffer.alloc(16, 1).toString('base64'), Buffer.alloc(KEYLEN, 2).toString('base64')].join('$');

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function readSid(req) {
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  return match ? decodeURIComponent(match[1]) : null;
}

function cookieAttrs(maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

// ورود: نشست جدید می‌سازد و کوکی HttpOnly می‌گذارد
async function createSession(db, userId) {
  const token = newToken();
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, hashToken(token), SESSION_DAYS]
  );
  return token;
}

// پیش‌هوک: کاربر معتبر را از کوکی پیدا می‌کند یا 401 می‌دهد
function requireUser(db) {
  return async function authenticate(req) {
    const token = readSid(req);
    if (!token) throw new HttpError(401, 'unauthenticated', 'ورود لازم است');
    const { rows } = await db.query(
      `SELECT u.id, u.shop_id, u.email, u.full_name, u.role, s.id AS session_id
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.disabled_at IS NULL`,
      [hashToken(token)]
    );
    if (!rows[0]) throw new HttpError(401, 'unauthenticated', 'نشست معتبر نیست');
    req.user = rows[0];
    req.sessionToken = token;
    db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [rows[0].session_id]).catch(() => {});
  };
}

// محدودیت ساده‌ی تلاش ورود به ازای IP (حافظه‌ی یک‌فرآیندی)
function loginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return function check(ip) {
    const now = Date.now();
    const entry = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (entry.length >= max) throw new HttpError(429, 'too_many_attempts', 'تعداد تلاش‌ها بیش از حد است؛ کمی بعد دوباره امتحان کنید');
    entry.push(now);
    hits.set(ip, entry);
  };
}

module.exports = {
  hashPassword, verifyPassword, DUMMY_HASH, createSession, requireUser,
  loginLimiter, cookieAttrs, SESSION_DAYS,
};
