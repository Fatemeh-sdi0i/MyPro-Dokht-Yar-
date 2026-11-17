const Fastify = require('fastify');
const { requireUser } = require('./auth');
const { publicAuthRoutes, protectedAuthRoutes } = require('./routes/auth');
const customersRoutes = require('./routes/customers');
const ordersRoutes = require('./routes/orders');
const { HttpError } = require('./util');

function buildApp({ db, loginMax, trustProxy = process.env.TRUST_PROXY === '1', logger = false }) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024, trustProxy });

  // خطاها به شکل یکنواخت: { error, message }
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err.validation) {
      return reply.code(400).send({ error: 'validation', message: 'داده‌ی ورودی معتبر نیست' });
    }
    if (err.code === '23505') {
      return reply.code(409).send({ error: 'conflict', message: 'این مورد قبلاً ثبت شده است' });
    }
    if (err.code === '23503' || err.code === '23514' || err.code === '22P02') {
      return reply.code(400).send({ error: 'invalid_data', message: 'داده‌ی ورودی پذیرفته نشد' });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'bad_request', message: 'درخواست نامعتبر است' });
    }
    req.log?.error?.(err);
    return reply.code(500).send({ error: 'internal', message: 'خطای داخلی سرور' });
  });

  app.get('/api/v1/healthz', async () => ({ ok: true }));

  app.register(async (pub) => {
    await publicAuthRoutes(pub, { db, loginMax });
  }, { prefix: '/api/v1' });

  app.register(async (priv) => {
    priv.addHook('onRequest', requireUser(db));
    await protectedAuthRoutes(priv, { db });
    priv.register(customersRoutes, { db });
    priv.register(ordersRoutes, { db });
  }, { prefix: '/api/v1' });

  return app;
}

module.exports = { buildApp };
