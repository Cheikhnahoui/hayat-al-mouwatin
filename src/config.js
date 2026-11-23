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
  dbPath: path.resolve(root, env.DATABASE_PATH || './data/hayat.db'),
  uploadDir: path.resolve(root, env.UPLOAD_DIR || './data/uploads'),
  appSecret: env.APP_SECRET || '',
  trustProxy: env.TRUST_PROXY ? parseInt(env.TRUST_PROXY, 10) || 1 : 0,
  maxImageBytes: (parseFloat(env.MAX_IMAGE_MB) || 8) * 1024 * 1024,
  maxVideoBytes: (parseFloat(env.MAX_VIDEO_MB) || 60) * 1024 * 1024,
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
