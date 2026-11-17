const {
  verifyPassword, DUMMY_HASH, createSession, requireUser, loginLimiter, cookieAttrs,
} = require('../auth');
const { HttpError } = require('../util');

const userView = (u) => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role });

// مسیرهای عمومی: ورود
async function publicAuthRoutes(app, { db, loginMax }) {
  const limit = loginLimiter({ max: loginMax || 10 });
  app.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    limit(req.ip);
    const email = req.body.email.trim().toLowerCase();
    const { rows } = await db.query(
      'SELECT id, shop_id, email, full_name, role, password_hash FROM users WHERE email = $1 AND disabled_at IS NULL',
      [email]
    );
    const user = rows[0];
    // همیشه یک بار هش بررسی می‌شود تا زمان پاسخ کاربر وجود داشتن را لو ندهد
    const ok = await verifyPassword(req.body.password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'ایمیل یا گذرواژه درست نیست');

    const token = await createSession(db, user.id);
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    reply.header('Set-Cookie', `sid=${encodeURIComponent(token)}; ${cookieAttrs(30 * 24 * 3600)}`);
    return { user: userView(user) };
  });
}

// مسیرهای محافظت‌شده: خروج و کاربر جاری
async function protectedAuthRoutes(app, { db }) {
  app.post('/auth/logout', async (req, reply) => {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.user.session_id]);
    reply.header('Set-Cookie', `sid=; ${cookieAttrs(0)}`);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => ({ user: userView(req.user) }));
}

module.exports = { publicAuthRoutes, protectedAuthRoutes, requireUser };
