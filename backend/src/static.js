const fs = require('node:fs');
const path = require('node:path');

// فقط این مسیرها از ریشه‌ی پروژه سرو می‌شوند؛ کد بک‌اند و تست‌ها هرگز سرو نمی‌شوند
const ALLOWED = ['index.html', 'manifest.webmanifest', 'sw.js', 'css/', 'js/', 'icons/'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(rootDir) {
  const root = path.resolve(rootDir);
  return async function staticHandler(req, reply) {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const allowed = ALLOWED.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
    const full = path.resolve(root, rel);
    if (!allowed || !full.startsWith(root + path.sep)) {
      return reply.code(404).send({ error: 'not_found', message: 'یافت نشد' });
    }
    try {
      const data = await fs.promises.readFile(full);
      reply.type(TYPES[path.extname(full)] || 'application/octet-stream');
      return reply.send(data);
    } catch (err) {
      return reply.code(404).send({ error: 'not_found', message: 'یافت نشد' });
    }
  };
}

module.exports = { serveStatic };
