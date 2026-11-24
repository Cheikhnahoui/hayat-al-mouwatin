'use strict';
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { sha256, token, safeEqual, clientIp } = require('./util');

const COOKIE = 'hm_sid';
const MAX_FAILS = 5, LOCK_MIN = 15;

// ---- passwords (scrypt, per-password salt) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${dk.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const dk = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(dk, Buffer.from(hash, 'base64'));
  } catch { return false; }
}
const DUMMY = hashPassword('dummy-password-for-timing');
function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'short';
  if (!/[A-Za-z\u0600-\u06FF]/.test(pw) || !/\d/.test(pw)) return 'weak';
  return null;
}

// ---- permissions ----
async function permissionsFor(userId) {
  const rows = (await db.prepare(`
    SELECT r.key AS role FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`).all(userId));
  const roles = rows.map((r) => r.role);
  const perms = new Set((await db.prepare(`
    SELECT DISTINCT p.key FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = ?`).all(userId)).map((r) => r.key));
  for (const o of (await db.prepare(`SELECT p.key, up.granted FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = ?`).all(userId))) {
    if (o.granted) perms.add(o.key); else perms.delete(o.key);
  }
  return { roles, perms };
}

// ---- sessions ----
async function createSession(req, res, userId) {
  const raw = token(32);
  const csrf = token(24);
  const exp = new Date(Date.now() + config.sessionHours * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  (await db.prepare('INSERT INTO sessions (id, user_id, csrf, ip, user_agent, expires_at) VALUES (?,?,?,?,?,?)')
    .run(sha256(raw), userId, csrf, clientIp(req), String(req.get('user-agent') || '').slice(0, 200), exp));
  res.cookie(COOKIE, raw, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: config.sessionHours * 3600e3, path: '/' });
}
async function destroySession(req, res) {
  const raw = parseCookies(req)[COOKIE];
  if (raw) (await db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(raw)));
  res.clearCookie(COOKIE, { path: '/' });
}
function parseCookies(req) {
  if (req._cookies) return req._cookies;
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
  }
  return (req._cookies = out);
}

// ---- login with lockout ----
async function attemptLogin(req, identifier) {
  const id = String(identifier || '').trim().toLowerCase().slice(0, 120);
  const user = (await db.prepare('SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?').get(id, id));
  return { id, user };
}
function isLocked(user) {
  return user && user.locked_until && new Date(user.locked_until.replace(' ', 'T') + 'Z') > new Date();
}
async function login(req, res, identifier, password) {
  const { id, user } = (await attemptLogin(req, identifier));
  const log = async (ok) => (await db.prepare('INSERT INTO login_attempts (identifier, ip, success) VALUES (?,?,?)').run(id, clientIp(req), ok ? 1 : 0));
  if (!user) { verifyPassword(password || '', DUMMY); (await log(false)); return { error: 'invalid' }; }
  if (isLocked(user)) { (await log(false)); return { error: 'locked' }; }
  if (!verifyPassword(password || '', user.password_hash)) {
    const fails = user.failed_logins + 1;
    if (fails >= MAX_FAILS) {
      (await db.prepare(`UPDATE users SET failed_logins = 0, locked_until = datetime('now', ?) WHERE id = ?`).run(`+${LOCK_MIN} minutes`, user.id));
    } else (await db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(fails, user.id));
    (await log(false));
    return { error: fails >= MAX_FAILS ? 'locked' : 'invalid' };
  }
  if (!user.is_active) { (await log(false)); return { error: 'inactive' }; }
  (await db.prepare(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?`).run(user.id));
  (await log(true));
  (await createSession(req, res, user.id));
  return { user };
}

// ---- middleware ----
async function loadUser(req, res, next) {
  req.user = null;
  const raw = parseCookies(req)[COOKIE];
  if (raw) {
    const row = (await db.prepare(`
      SELECT s.id AS sid, s.csrf, u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > datetime('now')`).get(sha256(raw)));
    if (row && row.is_active) {
      const { roles, perms } = (await permissionsFor(row.id));
      req.user = { ...row, roles, perms, isSuper: roles.includes('super_admin') };
      req.csrf = row.csrf;
      req.can = (p) => req.user.isSuper || req.user.perms.has(p);
    }
  }
  if (!req.can) req.can = () => false;
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
const requirePerm = (...perms) => (req, res, next) => {
  if (!req.user) return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
  if (perms.some((p) => req.can(p))) return next();
  return res.forbidden ? res.forbidden() : res.status(403).send('Forbidden');
};
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.user) return next(); // unauthenticated POSTs (login) have their own protection
  const sent = req.body?._csrf || req.get('x-csrf-token') || req.query?._csrf;
  if (sent && safeEqual(sent, req.csrf)) return next();
  return res.status(403).send('Invalid CSRF token');
}
async function purgeExpired() {
  (await db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run());
  (await db.prepare(`DELETE FROM login_attempts WHERE created_at < datetime('now','-30 days')`).run());
  (await db.prepare(`DELETE FROM comment_throttle WHERE created_at < datetime('now','-1 day')`).run());
}

module.exports = { hashPassword, verifyPassword, checkPasswordPolicy, permissionsFor, createSession, destroySession, parseCookies, login, loadUser, requireAuth, requirePerm, csrfProtect, purgeExpired, COOKIE };
