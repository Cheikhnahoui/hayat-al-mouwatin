'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../../db');
const config = require('../../config');
const auth = require('../../lib/auth');
const { audit } = require('../../lib/audit');
const { token, safeEqual, esc } = require('../../lib/util');
const K = require('../../views/admin/kit');

const router = express.Router();
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
router.use(noStore, express.urlencoded({ extended: false, limit: '2mb' }), auth.loadUser);
router.use((req, res, next) => {
  res.forbidden = () => {
    if (!req.user) return res.status(403).send('Forbidden');
    const c = K.ctxFor(req);
    res.status(403).send(K.shell(c, { title: c.L('غير مسموح', 'Accès refusé'), active: '', body: `<div class="box"><p>${esc(c.L('ليست لديك صلاحية للوصول إلى هذه الصفحة.', 'Vous n’avez pas la permission d’accéder à cette page.'))}</p></div>` }));
  };
  next();
});
router.use(auth.csrfProtect);

// ---------- login / logout ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
  handler: (req, res) => { setLc(req, res); res.status(429).send(loginPage(req, 'rate')); } });

function loginPage(req, error) {
  const lang = req.query.l === 'fr' ? 'fr' : req.query.l === 'ar' ? 'ar' : (auth.parseCookies(req).hm_lang === 'fr' ? 'fr' : 'ar');
  const L = (a, f) => (lang === 'ar' ? a : f);
  const lc = req._lc;
  const msgs = { invalid: L('بيانات الدخول غير صحيحة', 'Identifiants incorrects'), locked: L('الحساب مقفل مؤقتاً بعد محاولات فاشلة. حاول بعد 15 دقيقة.', 'Compte temporairement verrouillé. Réessayez dans 15 minutes.'),
    inactive: L('هذا الحساب معطّل', 'Ce compte est désactivé'), rate: L('محاولات كثيرة. حاول لاحقاً.', 'Trop de tentatives. Réessayez plus tard.'), csrf: L('انتهت صلاحية النموذج، أعد المحاولة', 'Formulaire expiré, réessayez') };
  const settings = require('../../lib/settings');
  return `<!DOCTYPE html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(L('تسجيل الدخول', 'Connexion'))}</title><link rel="icon" href="${esc(settings.get('favicon'))}"><link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/css/site.css?v=1"><link rel="stylesheet" href="/css/admin.css?v=1"></head>
<body class="adm"><div class="logbox"><form method="post" action="/admin/login${req.query.l ? '?l=' + lang : ''}" class="box f" autocomplete="on">
<div style="text-align:center"><img class="mk" src="${esc(settings.get('logo'))}" alt="" width="64" height="64"></div><h1 style="text-align:center">${esc(L('لوحة التحكم', 'Administration'))}</h1>
${error ? `<div class="flash err" role="alert">${esc(msgs[error] || msgs.invalid)}</div>` : ''}
<input type="hidden" name="lc" value="${esc(lc)}"><input type="hidden" name="next" value="${esc(req.query.next || req.body?.next || '')}">
<label>${esc(L('اسم المستخدم أو البريد', 'Identifiant ou e-mail'))}<input name="identifier" required autocomplete="username" autofocus maxlength="120"></label>
<label>${esc(L('كلمة المرور', 'Mot de passe'))}<input name="password" type="password" required autocomplete="current-password" maxlength="200"></label>
<button class="btn">${esc(L('دخول', 'Se connecter'))}</button>
<p class="meta" style="text-align:center"><a href="/admin/login?l=${lang === 'ar' ? 'fr' : 'ar'}">${lang === 'ar' ? 'Français' : 'العربية'}</a> · <a href="/${lang}">${esc(L('العودة للموقع', 'Retour au site'))}</a></p></form></div></body></html>`;
}
function setLc(req, res) {
  const t = token(18);
  res.cookie('hm_lc', t, { httpOnly: true, sameSite: 'strict', secure: config.isProd, maxAge: 3600e3, path: '/admin' });
  req._lc = t;
}
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/admin');
  setLc(req, res);
  res.send(loginPage(req));
});
router.post('/login', loginLimiter, async (req, res) => {
  const cookieTok = auth.parseCookies(req).hm_lc;
  if (!cookieTok || !req.body.lc || !safeEqual(cookieTok, req.body.lc)) { setLc(req, res); return res.status(403).send(loginPage(req, 'csrf')); }
  const r = (await auth.login(req, res, req.body.identifier, req.body.password));
  if (r.error) { setLc(req, res); return res.status(r.error === 'locked' ? 423 : 401).send(loginPage(req, r.error)); }
  req.user = { id: r.user.id };
  (await audit(req, 'auth.login', 'user', r.user.id));
  const next = String(req.body.next || '');
  res.clearCookie('hm_lc', { path: '/admin' });
  res.redirect(next.startsWith('/admin') && !next.startsWith('//') ? next : '/admin');
});
router.post('/logout', async (req, res) => {
  if (req.user) (await audit(req, 'auth.logout', 'user', req.user.id));
  (await auth.destroySession(req, res));
  res.redirect('/admin/login');
});

// everything below requires a session
router.use(auth.requireAuth);
router.use(async (req, res, next) => {
  req.unread = (await db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id)).n;
  next();
});
router.use((req, res, next) => {
  // force password change after an admin reset
  if (req.user.must_change_password && !['/profile', '/profile/password', '/logout', '/lang/ar', '/lang/fr'].includes(req.path)) return res.redirect('/admin/profile?e=short');
  next();
});
router.get('/lang/:l', async (req, res) => {
  if (['ar', 'fr'].includes(req.params.l)) (await db.prepare('UPDATE users SET ui_lang = ? WHERE id = ?').run(req.params.l, req.user.id));
  res.redirect(String(req.get('referer') || '/admin').replace(/^https?:\/\/[^/]+/, '').startsWith('/admin') ? String(req.get('referer')).replace(/^https?:\/\/[^/]+/, '') : '/admin');
});

router.use('/', require('./dashboard'));
router.use('/articles', require('./articles'));
router.use('/', require('./taxonomy'));
router.use('/media', require('./media'));
router.use('/ads', require('./ads'));
router.use('/users', require('./users'));
router.use('/', require('./misc'));

// /admin/<section>/<id>/edit (or /view) -> the page that exists at /admin/<section>/<id>
router.get(/^\/(articles|categories|users|ads|media)\/(\d+)\/(edit|view|show|update)\/?$/, (req, res) => res.redirect(`/admin/${req.params[0]}/${req.params[1]}`));
// publishing is a POST action; if someone opens its URL in the browser, show the article page where the button is
router.get(/^\/articles\/(\d+)\/(publish|submit|approve|reject|schedule|unpublish|archive|restore|delete|feature)\/?$/, (req, res) => res.redirect(`/admin/articles/${req.params[0]}`));
// friendly aliases for common guesses
for (const [from, to] of [['/tags', '/admin'], ['/audit', '/admin'], ['/dashboard', '/admin'], ['/news', '/admin/articles'], ['/posts', '/admin/articles'], ['/article', '/admin/articles'], ['/articles/add', '/admin/articles/new'], ['/news/new', '/admin/articles/new'], ['/add', '/admin/articles/new']]) router.get(from, (req, res) => res.redirect(to));
router.use((req, res) => {
  const c = K.ctxFor(req);
  res.status(404).send(K.shell(c, { title: '404', active: '', body: `<div class="box"><p>${esc(c.L('الصفحة غير موجودة', 'Page introuvable'))}</p><p class="meta-line" dir="ltr">${esc(req.originalUrl)}</p><p><a class="btn" href="/admin">${esc(c.L('العودة إلى لوحة التحكم', 'Retour au tableau de bord'))}</a></p></div>` }));
});
module.exports = router;
