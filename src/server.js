'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const db = require('./db');
const { ensureSeeded } = require('./db/seed');
const settings = require('./lib/settings');
const articles = require('./lib/articles');
const ads = require('./lib/ads');
const auth = require('./lib/auth');
const media = require('./lib/media');

// One-time start-up work per process (serverless cold start or `npm start`): migrations + base data.
let readyPromise = null;
const ready = () => (readyPromise ||= ensureSeeded().catch((e) => { readyPromise = null; throw e; }));

// Scheduled work. On Vercel there are no timers, so it runs lazily on traffic (at most every 30 s)
// and from the cron endpoint; with `npm start` a timer also calls it.
let lastJobs = 0;
async function runJobs() {
  const published = await articles.publishDue();
  await ads.checkEnding();
  return published;
}
async function lazyJobs() {
  if (Date.now() - lastJobs < 30e3) return;
  lastJobs = Date.now();
  try { await runJobs(); } catch (e) { console.error('[jobs]', e.message); }
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  const blobHost = media.blobHost();
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', ...(blobHost ? [blobHost] : [])],
        mediaSrc: ["'self'", ...(blobHost ? [blobHost] : [])],
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

  app.get('/healthz', async (req, res) => { await db.prepare('SELECT 1 AS ok').get(); res.json({ ok: true }); });
  // uploaded media: local disk, or redirect to the Vercel Blob store
  app.use('/uploads', media.serve());
  app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '1h' : 0, index: false }));

  // database ready + fresh settings for every dynamic request
  app.use(async (req, res, next) => {
    await ready();
    await settings.refresh();
    next();
  });

  // Vercel Cron (or any external scheduler): GET /api/cron with "Authorization: Bearer $CRON_SECRET"
  app.get('/api/cron', async (req, res) => {
    if (!config.cronSecret || req.get('authorization') !== `Bearer ${config.cronSecret}`) return res.status(401).json({ error: 'unauthorized' });
    const published = await runJobs();
    await auth.purgeExpired();
    res.json({ ok: true, published });
  });
  app.use(async (req, res, next) => { if (!req.path.startsWith('/admin')) await lazyJobs(); next(); });

  app.use('/admin', require('./routes/admin'));
  app.use('/', require('./routes/public'));

  app.use((req, res) => res.redirect(302, '/'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return;
    if (err.type === 'entity.too.large') return res.status(413).send('Payload too large');
    const debug = !config.isProd || process.env.DEBUG_STARTUP === '1'; // DEBUG_STARTUP=1 shows error details (temporary, for diagnosis)
    res.status(err.status && err.status < 500 ? err.status : 500).type('text/plain').send(debug ? String(err.stack || err) : 'Internal error');
  });
  return app;
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

if (require.main === module) {
  const app = createApp();
  ready().then(() => {
    // long-running server (not serverless): also run jobs on a timer
    setInterval(() => runJobs().catch((e) => console.error('[jobs]', e.message)), 60e3).unref();
    setInterval(() => auth.purgeExpired().catch((e) => console.error(e.message)), 3600e3).unref();
    app.listen(config.port, () => console.log(`Hayat Al Mouwatin listening on ${config.siteUrl} (port ${config.port}, ${config.isProd ? 'production' : 'development'})`));
  }).catch((e) => { console.error('Startup failed:', e); process.exit(1); });
}
module.exports = { createApp, ready, runJobs };
