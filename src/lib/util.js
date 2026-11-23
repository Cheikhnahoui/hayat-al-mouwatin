'use strict';
const crypto = require('crypto');
const config = require('../config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', config.appSecret).update(String(s)).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Unicode-aware slug (keeps Arabic letters)
function slugify(str, max = 80) {
  const s = String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u064B-\u065F\u0670\u0640]/g, '') // latin accents, Arabic harakat + tatweel
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'item';
}

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toISOString().slice(0, 10);
// datetime-local (Mauritania = UTC+0) <-> sql
const toInput = (sql) => (sql ? String(sql).slice(0, 16).replace(' ', 'T') : '');
const fromInput = (v) => (v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? v.replace('T', ' ') + ':00' : null);

const isHttpUrl = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };
const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';

function fmtDate(sql, lang, withTime = false) {
  if (!sql) return '';
  const d = new Date(String(sql).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  const o = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' };
  if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
  return d.toLocaleDateString(lang === 'ar' ? 'ar-MR-u-nu-latn' : 'fr-FR', o);
}
const num = (n, lang) => Number(n || 0).toLocaleString(lang === 'ar' ? 'ar-MR-u-nu-latn' : 'fr-FR');

module.exports = { esc, sha256, hmac, token, safeEqual, slugify, nowSql, today, toInput, fromInput, isHttpUrl, clientIp, fmtDate, num };
