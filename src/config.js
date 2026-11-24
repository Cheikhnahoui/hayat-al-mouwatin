'use strict';
const path = require('path');
require('dotenv').config({ quiet: true });

const root = path.resolve(__dirname, '..');
const env = process.env;
const isProd = env.NODE_ENV === 'production';

const config = {
  root,
  isProd,
  port: parseInt(env.PORT || '3000', 10),
  siteUrl: (env.SITE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
  // libSQL URL: file:./data/hayat.db (local) or libsql://<db>.turso.io (Vercel / production)
  databaseUrl: env.DATABASE_URL || ('file:' + path.resolve(root, env.DATABASE_PATH || './data/hayat.db').replace(/\\/g, '/')),
  databaseToken: env.DATABASE_AUTH_TOKEN || '',
  isVercel: !!env.VERCEL,
  blobToken: env.BLOB_READ_WRITE_TOKEN || '',
  blobBaseUrl: (env.BLOB_PUBLIC_URL || '').replace(/\/+$/, ''),
  cronSecret: env.CRON_SECRET || '',
  uploadDir: env.UPLOAD_DIR ? path.resolve(root, env.UPLOAD_DIR) : (env.VERCEL ? '/tmp/uploads' : path.resolve(root, './data/uploads')),
  appSecret: env.APP_SECRET || '',
  trustProxy: parseInt(env.TRUST_PROXY || (env.VERCEL ? '1' : '0'), 10) || 0,
  // Vercel functions accept request bodies up to 4.5 MB
  maxImageBytes: (parseFloat(env.MAX_IMAGE_MB) || (env.VERCEL ? 4 : 8)) * 1024 * 1024,
  maxVideoBytes: (parseFloat(env.MAX_VIDEO_MB) || (env.VERCEL ? 4 : 60)) * 1024 * 1024,
  sessionHours: 12,
  langs: ['ar', 'fr'],
  defaultLang: 'ar',
};

if (isProd && (config.appSecret.length < 32 || config.appSecret.startsWith('change-me'))) {
  console.error('FATAL: APP_SECRET must be set to a random string of at least 32 characters in production.');
  process.exit(1);
}
if (!config.appSecret) config.appSecret = 'dev-only-secret-' + require('crypto').randomBytes(16).toString('hex');

module.exports = config;
