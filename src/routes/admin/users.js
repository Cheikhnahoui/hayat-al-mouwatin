'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const auth = require('../../lib/auth');
const { PERMISSIONS } = require('../../lib/rbac');
const K = require('../../views/admin/kit');
const { esc, num } = require('../../lib/util');
const { text } = require('../../lib/sanitize');
const { audit } = require('../../lib/audit');
const { notifyPermission } = require('../../lib/notify');
const router = express.Router();

const manageAny = (req) => req.can('users.manage');
router.use((req, res, next) => (['users.view', 'users.manage', 'journalists.manage'].some((p) => req.can(p)) ? next() : res.forbidden()));

const rolesOf = async (id) => (await db.prepare('SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?').all(id)).map((r) => r.key);
// can the current actor manage this target?
async function canManage(req, target /* may be null for create */, newRoles) {
  const roles = target ? (await rolesOf(target.id)) : [];
  if ((roles.includes('super_admin') || (newRoles || []).includes('super_admin')) && !req.user.isSuper) return false;
  if (manageAny(req)) return true;
  if (req.can('journalists.manage')) {
    const all = [...roles, ...(newRoles || [])];
    return all.every((r) => r === 'journalist');
  }
  return false;
}
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

router.get('/', async (req, res) => {
  const c = K.ctxFor(req), { L, lang } = c;
  const role = String(req.query.role || '');
  const rows = (await db.prepare(`SELECT u.*, (SELECT group_concat(r.key) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id) roles,
    (SELECT COUNT(*) FROM articles WHERE author_id=u.id) n FROM users u ${role ? 'WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.key=@r)' : ''} ORDER BY u.id DESC`).all({ r: role }));
  const R = Object.fromEntries((await db.prepare('SELECT key, name_ar, name_fr FROM roles').all()).map((r) => [r.key, lang === 'ar' ? r.name_ar : r.name_fr]));
  const canCreate = manageAny(req) || req.can('journalists.manage');
  const body = `<div class="bar">${canCreate ? `<a class="btn" href="/admin/users/new">+ ${esc(L('مستخدم جديد', 'Nouvel utilisateur'))}</a>` : ''}<a class="btn gh sm" href="/admin/users">${esc(L('الكل', 'Tous'))}</a><a class="btn gh sm" href="/admin/users?role=journalist">${esc(L('الصحفيون', 'Journalistes'))}</a></div>
<div class="box">${K.table([L('المستخدم', 'Utilisateur'), L('البريد', 'E-mail'), L('الأدوار', 'Rôles'), L('الحالة', 'État'), L('مقالات', 'Articles'), L('آخر دخول', 'Dernière connexion'), ''],
    rows.map((u) => `<tr><td><b>${esc((lang === 'ar' ? u.name_ar : u.name_fr) || u.username)}</b><br><span class="meta-line">@${esc(u.username)}</span></td><td>${esc(u.email)}</td><td>${(u.roles || '').split(',').filter(Boolean).map((k) => `<span class="badge">${esc(R[k] || k)}</span>`).join(' ')}</td><td>${u.is_active ? '✔' : '✖'}</td><td>${num(u.n, lang)}</td><td>${u.last_login_at ? K.dt(c, u.last_login_at) : '—'}</td><td><a class="btn gh sm" href="/admin/users/${u.id}">${esc(L('فتح', 'Ouvrir'))}</a></td></tr>`))}</div>`;
  res.send(K.shell(c, { title: L('المستخدمون', 'Utilisateurs'), active: 'users', body }));
});

async function form(req, res, u, vals, err, newPw) {
  const c = K.ctxFor(req), { L, lang } = c;
  const v = (k, d = '') => (vals && k in vals ? vals[k] : d);
  const roles = (await db.prepare('SELECT * FROM roles ORDER BY id').all());
  const have = u ? (await rolesOf(u.id)) : (vals ? [].concat(vals.roles || []) : ['journalist']);
  const canRoles = req.can('roles.manage');
  const ovr = u ? Object.fromEntries((await db.prepare('SELECT p.key, up.granted FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = ?').all(u.id)).map((r) => [r.key, r.granted])) : {};
  const eff = u ? (await auth.permissionsFor(u.id)) : { perms: new Set() };
  const editable = u ? (await canManage(req, u)) : true;
  const dis = editable ? '' : 'disabled';
  let extra = '';
  if (u) {
    const acts = (await db.prepare('SELECT * FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(u.id));
    const arts = (await db.prepare(`SELECT a.id, a.status, a.published_at, (SELECT title FROM article_translations WHERE article_id=a.id ORDER BY lang LIMIT 1) title FROM articles a WHERE a.author_id = ? ORDER BY a.updated_at DESC LIMIT 15`).all(u.id));
    extra = `<div class="two"><div class="box"><h3>${esc(L('مقالات الكاتب', 'Articles de l’auteur'))}</h3>${arts.map((a) => `<div style="padding:3px 0">${K.badge(c, a.status)} <a href="/admin/articles/${a.id}">${esc(a.title || '#' + a.id)}</a></div>`).join('') || '—'}<p><a href="/${lang}/author/${u.id}" target="_blank" rel="noopener">${esc(L('الصفحة العامة للكاتب', 'Profil public'))} ↗</a></p></div>
<div class="box"><h3>${esc(L('النشاط', 'Activité'))}</h3>${acts.map((a) => `<div class="meta-line" style="padding:3px 0">${esc(a.action)} ${esc(a.entity)} ${esc(a.entity_id)} · ${K.dt(c, a.created_at)}</div>`).join('') || '—'}</div></div>`;
  }
  const body = `${err ? `<div class="flash err">${esc(L(...(K.ERR[err] || K.ERR.invalid)))}</div>` : ''}
${newPw ? `<div class="flash"><b>${esc(L('كلمة مرور مؤقتة (تُعرض مرة واحدة):', 'Mot de passe temporaire (affiché une seule fois) :'))}</b> <code>${esc(newPw)}</code><br>${esc(L('سيُطلب من المستخدم تغييرها عند أول دخول.', 'L’utilisateur devra le changer à la première connexion.'))}</div>` : ''}
<form method="post" class="f" action="${u ? `/admin/users/${u.id}` : '/admin/users'}">${K.csrfField(c)}<div class="two"><div class="box f"><h3>${esc(L('الحساب', 'Compte'))}</h3>
<div class="row2"><label>${esc(L('اسم المستخدم', 'Identifiant'))}<input name="username" required pattern="[a-zA-Z0-9_.\\-]{3,32}" value="${esc(v('username', u?.username || ''))}" ${u ? 'readonly' : ''}></label><label>${esc(L('البريد الإلكتروني', 'E-mail'))}<input type="email" name="email" required value="${esc(v('email', u?.email || ''))}" ${dis}></label></div>
<div class="row2"><label>${esc(L('الاسم (عربي)', 'Nom (arabe)'))}<input name="name_ar" dir="rtl" value="${esc(v('name_ar', u?.name_ar || ''))}" maxlength="80" ${dis}></label><label>${esc(L('الاسم (فرنسي)', 'Nom (français)'))}<input name="name_fr" value="${esc(v('name_fr', u?.name_fr || ''))}" maxlength="80" ${dis}></label></div>
<label>${esc(L('نبذة (عربي)', 'Bio (AR)'))}<textarea name="bio_ar" dir="rtl" rows="2" maxlength="500" ${dis}>${esc(v('bio_ar', u?.bio_ar || ''))}</textarea></label><label>${esc(L('نبذة (فرنسي)', 'Bio (FR)'))}<textarea name="bio_fr" rows="2" maxlength="500" ${dis}>${esc(v('bio_fr', u?.bio_fr || ''))}</textarea></label>
${u ? '' : `<label>${esc(L('كلمة المرور (اتركها فارغة لتوليد كلمة مؤقتة)', 'Mot de passe (vide = généré)'))}<input name="password" type="password" autocomplete="new-password"></label>`}
<label class="chk"><input type="checkbox" name="is_active" value="1" ${(vals ? vals.is_active : u ? u.is_active : 1) ? 'checked' : ''} ${dis}> ${esc(L('الحساب مفعّل', 'Compte actif'))}</label></div>
<div class="box f"><h3>${esc(L('الأدوار والصلاحيات', 'Rôles et permissions'))}</h3>
${roles.map((r) => `<label class="chk"><input type="checkbox" name="roles" value="${r.key}" ${have.includes(r.key) ? 'checked' : ''} ${canRoles && editable && (r.key !== 'super_admin' || req.user.isSuper) ? '' : 'disabled'}> ${esc(lang === 'ar' ? r.name_ar : r.name_fr)}</label>`).join('')}
${!canRoles ? '' : `<details><summary>${esc(L('تخصيص الصلاحيات لهذا المستخدم', 'Permissions personnalisées'))}</summary><p class="meta-line">${esc(L('افتراضي = حسب الدور؛ منح = إضافة؛ سحب = إزالة', 'Défaut = selon le rôle ; Accorder ; Retirer'))}</p><div class="chk-grid">${Object.keys(PERMISSIONS).map((k) => `<label>${esc(k)}<select name="p_${k}" ${dis}><option value="">${eff.perms.has(k) && !(k in ovr) ? '✔ ' : ''}${esc(L('افتراضي', 'Défaut'))}</option><option value="1" ${ovr[k] === 1 ? 'selected' : ''}>${esc(L('منح', 'Accorder'))}</option><option value="0" ${ovr[k] === 0 ? 'selected' : ''}>${esc(L('سحب', 'Retirer'))}</option></select></label>`).join('')}</div></details>`}</div></div>
${editable ? `<div><button class="btn">${esc(L('حفظ', 'Enregistrer'))}</button></div>` : ''}</form>
${u && editable ? K.postForm(c, `/admin/users/${u.id}/reset-password`, `<button class="btn warn sm">${esc(L('إعادة تعيين كلمة المرور', 'Réinitialiser le mot de passe'))}</button>`, { confirm: L('توليد كلمة مرور مؤقتة جديدة؟', 'Générer un mot de passe temporaire ?') }) : ''}${extra}`;
  res.send(K.shell(c, { title: u ? (u.name_ar || u.username) : L('مستخدم جديد', 'Nouvel utilisateur'), active: 'users', back: '/admin/users', body }));
}
router.get('/new', async (req, res) => (manageAny(req) || req.can('journalists.manage') ? (await form(req, res, null)) : res.forbidden()));
router.get('/:id', async (req, res, next) => { const u = (await db.prepare('SELECT * FROM users WHERE id = ?').get(+req.params.id)); if (!u) return next(); (await form(req, res, u)); });

const tempPw = () => crypto.randomBytes(9).toString('base64url') + 'a7';

async function applyRoles(req, userId, b) {
  if (!req.can('roles.manage')) return null;
  const want = [].concat(b.roles || []).filter((r) => typeof r === 'string');
  const valid = (await db.prepare('SELECT key FROM roles').all()).map((r) => r.key).filter((k) => want.includes(k));
  if (valid.includes('super_admin') && !req.user.isSuper) return 'forbidden';
  const before = (await rolesOf(userId));
  // never remove the last super admin
  if (before.includes('super_admin') && !valid.includes('super_admin')) {
    if (!req.user.isSuper) return 'forbidden';
    const n = (await db.prepare("SELECT COUNT(*) n FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users u ON u.id=ur.user_id WHERE r.key='super_admin' AND u.is_active=1").get()).n;
    if (n <= 1) return 'last_super';
  }
  (await db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId));
  for (const k of valid) (await db.prepare('INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE key = ?').run(userId, k));
  (await db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId));
  for (const k of Object.keys(PERMISSIONS)) {
    const o = b['p_' + k];
    if (o === '1' || o === '0') {
      if (o === '1' && !req.user.isSuper && !req.can(k)) continue; // cannot grant what you don't have
      (await db.prepare('INSERT INTO user_permissions (user_id, permission_id, granted) SELECT ?, id, ? FROM permissions WHERE key = ?').run(userId, +o, k));
    }
  }
  if (JSON.stringify(before.sort()) !== JSON.stringify(valid.sort())) (await audit(req, 'user.roles', 'user', userId, valid.join(',')));
  return null;
}

router.post('/', async (req, res) => {
  const b = req.body;
  const roles = req.can('roles.manage') ? [].concat(b.roles || []) : ['journalist'];
  if (!(await canManage(req, null, roles))) return res.forbidden();
  const username = String(b.username || '').trim(), email = String(b.email || '').trim().toLowerCase();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || !validEmail(email)) return (await form(req, res, null, b, 'invalid'));
  if ((await db.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?) OR lower(email)=lower(?)').get(username, email))) return (await form(req, res, null, b, 'exists'));
  let pw = b.password || '', shown = null;
  if (!pw) { pw = tempPw(); shown = pw; } else { const pe = auth.checkPasswordPolicy(pw); if (pe) return (await form(req, res, null, b, pe)); }
  const id = (await db.prepare('INSERT INTO users (username, email, password_hash, name_ar, name_fr, bio_ar, bio_fr, is_active, must_change_password) VALUES (?,?,?,?,?,?,?,?,1)')
    .run(username, email, auth.hashPassword(pw), text(b.name_ar).slice(0, 80), text(b.name_fr).slice(0, 80), text(b.bio_ar).slice(0, 500), text(b.bio_fr).slice(0, 500), b.is_active ? 1 : 0)).lastInsertRowid;
  if (req.can('roles.manage')) { const e = (await applyRoles(req, id, b)); if (e) { (await db.prepare('DELETE FROM users WHERE id = ?').run(id)); return (await form(req, res, null, b, e)); } }
  else (await db.prepare("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE key = 'journalist'").run(id));
  (await audit(req, 'user.create', 'user', id, username));
  (await notifyPermission('users.manage', 'user_created', `تم إنشاء مستخدم جديد: ${username}`, `Nouvel utilisateur créé : ${username}`, `/admin/users/${id}`, req.user.id));
  (await form(req, res, (await db.prepare('SELECT * FROM users WHERE id = ?').get(id)), null, null, shown));
});
router.post('/:id', async (req, res, next) => {
  const u = (await db.prepare('SELECT * FROM users WHERE id = ?').get(+req.params.id));
  if (!u) return next();
  if (!(await canManage(req, u))) return res.forbidden();
  const b = req.body, email = String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) return (await form(req, res, u, b, 'invalid'));
  if ((await db.prepare('SELECT 1 FROM users WHERE lower(email)=? AND id<>?').get(email, u.id))) return (await form(req, res, u, b, 'exists'));
  const active = b.is_active ? 1 : 0;
  if (!active && u.id === req.user.id) return (await form(req, res, u, b, 'self'));
  if (!active && (await rolesOf(u.id)).includes('super_admin') && (await db.prepare("SELECT COUNT(*) n FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users x ON x.id=ur.user_id WHERE r.key='super_admin' AND x.is_active=1").get()).n <= 1) return (await form(req, res, u, b, 'last_super'));
  (await db.transaction(async () => {
    (await db.prepare("UPDATE users SET email=?, name_ar=?, name_fr=?, bio_ar=?, bio_fr=?, is_active=?, updated_at=datetime('now') WHERE id=?")
      .run(email, text(b.name_ar).slice(0, 80), text(b.name_fr).slice(0, 80), text(b.bio_ar).slice(0, 500), text(b.bio_fr).slice(0, 500), active, u.id));
    if (!active) (await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id));
  })());
  const e = (await applyRoles(req, u.id, b));
  if (e) return (await form(req, res, (await db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)), b, e));
  (await audit(req, 'user.update', 'user', u.id, active ? '' : 'deactivated'));
  res.redirect(`/admin/users/${u.id}?m=saved`);
});
router.post('/:id/reset-password', async (req, res, next) => {
  const u = (await db.prepare('SELECT * FROM users WHERE id = ?').get(+req.params.id));
  if (!u) return next();
  if (!(await canManage(req, u))) return res.forbidden();
  const pw = tempPw();
  (await db.prepare("UPDATE users SET password_hash=?, must_change_password=1, failed_logins=0, locked_until=NULL, updated_at=datetime('now') WHERE id=?").run(auth.hashPassword(pw), u.id));
  (await db.prepare('DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? AND 0)').run(u.id, req.user.id));
  (await audit(req, 'user.reset_password', 'user', u.id));
  (await form(req, res, u, null, null, pw));
});
module.exports = router;
