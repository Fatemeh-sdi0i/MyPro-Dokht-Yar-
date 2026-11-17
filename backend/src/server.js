const { createPool } = require('./db');
const { buildApp } = require('./app');

const db = createPool();
const app = buildApp({ db, logger: true });
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// خاموش‌شدن تمیز: درخواست‌های در حال اجرا تمام شوند و اتصال دیتابیس بسته شود
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
