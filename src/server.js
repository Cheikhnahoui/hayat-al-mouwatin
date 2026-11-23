'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const db = require('./db');
const { seed } = require('./db/seed');
const articles = require('./lib/articles');
const ads = require('./lib/ads');
const auth = require('./lib/auth');

function createApp() {
  seed(); // runs migrations + idempotent base data
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'"],
        frameSrc: ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: config.isProd,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  app.use(compression());

  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny', setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff') }));
  app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '1h' : 0, index: false }));

  app.use('/admin', require('./routes/admin'));
  app.use('/', require('./routes/public'));

  // global 404 (outside a language prefix)
  app.use((req, res) => res.redirect(302, '/'));
  // error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return;
    if (err.type === 'entity.too.large') return res.status(413).send('Payload too large');
    res.status(err.status && err.status < 500 ? err.status : 500).type('text/plain').send(config.isProd ? 'Internal error' : String(err.stack || err));
  });
  return app;
}

function startJobs() {
  const tick = () => { try { articles.publishDue(); ads.checkEnding(); } catch (e) { console.error('[job]', e.message); } };
  tick();
  setInterval(tick, 60e3).unref();
  setInterval(() => { try { auth.purgeExpired(); } catch (e) { console.error(e.message); } }, 3600e3).unref();
}

if (require.main === module) {
  const app = createApp();
  startJobs();
  app.listen(config.port, () => console.log(`Hayat Al Mouwatin listening on ${config.siteUrl} (port ${config.port}, ${config.isProd ? 'production' : 'development'})`));
}
module.exports = { createApp, startJobs };
