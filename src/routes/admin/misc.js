'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../../db');
const auth = require('../../lib/auth');
const settings = require('../../lib/settings');
const M = require('../../lib/media');
const config = require('../../config');
const K = require('../../views/admin/kit');
const { esc, num, isHttpUrl } = require('../../lib/util');
const { text } = require('../../lib/sanitize');
const { audit } = require('../../lib/audit');
const router = express.Router();
const need = (...p) => (req, res, next) => (p.some((x) => req.can(x)) ? next() : res.forbidden());

// ================= NOTIFICATIONS =================
router.get('/notifications', async (req, res) => {
  const c = K.ctxFor(req), { L, lang } = c;
  const rows = (await db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id));
  const body = `<div class="bar">${K.postForm(c, '/admin/notifications/read-all', `<button class="btn gh sm">${esc(L('تعليم الكل كمقروء', 'Tout marquer comme lu'))}</button>`)}</div>
<div class="box">${rows.map((n) => `<div class="notif-item ${n.is_read ? '' : 'unread'}"><div>${n.link ? `<a href="/admin/notifications/${n.id}/open">${esc(lang === 'ar' ? n.message_ar : n.message_fr)}</a>` : esc(lang === 'ar' ? n.message_ar : n.message_fr)}<div class="meta-line">${K.dt(c, n.created_at)}</div></div>${n.is_read ? '' : K.postForm(c, `/admin/notifications/${n.id}/read`, `<button class="btn gh sm">✓</button>`)}</div>`).join('') || `<p class="meta">${esc(L('لا توجد إشعارات', 'Aucune notification'))}</p>`}</div>`;
  res.send(K.shell(c, { title: L('الإشعارات', 'Notifications'), active: '', body }));
});
router.post('/notifications/read-all', async (req, res) => { (await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id)); res.redirect('/admin/notifications'); });
router.post('/notifications/:id/read', async (req, res) => { (await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(+req.params.id, req.user.id)); res.redirect('/admin/notifications'); });
router.get('/notifications/:id/open', async (req, res) => {
  const n = (await db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(+req.params.id, req.user.id));
  if (!n) return res.redirect('/admin/notifications');
  (await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(n.id));
  res.redirect(n.link.startsWith('/admin') ? n.link : '/admin/notifications');
});

// ================= COMMENTS =================
router.get('/comments', need('comments.moderate'), async (req, res) => {
  const c = K.ctxFor(req), { L, lang } = c;
  const st = ['pending', 'approved', 'rejected', 'spam'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = (await db.prepare(`SELECT c.*, (SELECT title FROM article_translations WHERE article_id=c.article_id ORDER BY lang LIMIT 1) title FROM comments c WHERE c.status = ? ORDER BY c.reports DESC, c.id DESC LIMIT 100`).all(st));
  const counts = Object.fromEntries((await db.prepare('SELECT status, COUNT(*) n FROM comments GROUP BY status').all()).map((r) => [r.status, r.n]));
  const LBL = { pending: ['بانتظار المراجعة', 'En attente'], approved: ['معتمدة', 'Approuvés'], rejected: ['مرفوضة', 'Rejetés'], spam: ['مزعجة', 'Spam'] };
  const act = (id, a, label, cls) => K.postForm(c, `/admin/comments/${id}/${a}`, `<button class="btn ${cls} sm">${esc(label)}</button>`);
  const body = `<div class="bar">${Object.keys(LBL).map((s) => `<a class="btn ${s === st ? '' : 'gh'} sm" href="/admin/comments?status=${s}">${esc(L(...LBL[s]))} (${counts[s] || 0})</a>`).join(' ')}</div>
<div class="box">${rows.map((r) => `<div class="notif-item" style="align-items:flex-start"><div><b>${esc(r.author_name)}</b> ${r.author_email ? `<span class="meta-line">&lt;${esc(r.author_email)}&gt;</span>` : ''} · <a href="/admin/articles/${r.article_id}">${esc(r.title)}</a>${r.reports ? ` <span class="badge st-rejected">⚑ ${r.reports}</span>` : ''}<p style="margin:4px 0">${esc(r.body).replace(/\n/g, '<br>')}</p><span class="meta-line">${K.dt(c, r.created_at)}</span></div><div style="display:flex;gap:4px;flex-wrap:wrap">${st !== 'approved' ? act(r.id, 'approve', L('اعتماد', 'Approuver'), 'ok') : ''}${st !== 'rejected' ? act(r.id, 'reject', L('رفض', 'Rejeter'), 'warn') : ''}${st !== 'spam' ? act(r.id, 'spam', 'Spam', 'gh') : ''}${act(r.id, 'delete', L('حذف', 'Supprimer'), 'dg')}</div></div>`).join('') || '<p class="meta">—</p>'}</div>`;
  res.send(K.shell(c, { title: L('التعليقات', 'Commentaires'), active: 'comments', body }));
});
for (const [a, st] of [['approve', 'approved'], ['reject', 'rejected'], ['spam', 'spam']]) {
  router.post(`/comments/:id/${a}`, need('comments.moderate'), async (req, res) => {
    (await db.prepare('UPDATE comments SET status = ?, reports = CASE WHEN ? = \'approved\' THEN 0 ELSE reports END WHERE id = ?').run(st, st, +req.params.id));
    (await audit(req, 'comment.' + a, 'comment', req.params.id)); res.redirect(req.get('referer')?.includes('/admin/comments') ? new URL(req.get('referer')).pathname + new URL(req.get('referer')).search : '/admin/comments');
  });
}
router.post('/comments/:id/delete', need('comments.moderate'), async (req, res) => {
  (await db.prepare('DELETE FROM comments WHERE id = ?').run(+req.params.id));
  (await audit(req, 'comment.delete', 'comment', req.params.id)); res.redirect('/admin/comments?m=deleted');
});

// ================= ANALYTICS =================
router.get('/analytics', need('analytics.view'), async (req, res) => {
  const c = K.ctxFor(req), { L, lang } = c;
  const days = [7, 30, 90].includes(+req.query.days) ? +req.query.days : 30;
  const top = (await db.prepare(`SELECT a.id, (SELECT title FROM article_translations WHERE article_id=a.id ORDER BY lang LIMIT 1) title, SUM(v.views) views FROM article_views v JOIN articles a ON a.id=v.article_id WHERE v.day >= date('now', ?) GROUP BY a.id ORDER BY views DESC LIMIT 15`).all(`-${days} days`));
  const cat = (await db.prepare(`SELECT ct.name, SUM(v.views) views FROM article_views v JOIN articles a ON a.id=v.article_id JOIN category_translations ct ON ct.category_id=a.category_id AND ct.lang=? WHERE v.day >= date('now', ?) GROUP BY a.category_id ORDER BY views DESC`).all(lang, `-${days} days`));
  const auth_ = (await db.prepare(`SELECT u.id, u.name_ar, u.name_fr, u.username, COUNT(DISTINCT a.id) n, COALESCE(SUM(a.view_count),0) views FROM users u JOIN articles a ON a.author_id=u.id WHERE a.status='published' GROUP BY u.id ORDER BY views DESC LIMIT 10`).all());
  const sum = (await db.prepare(`SELECT COALESCE(SUM(views),0) n FROM article_views WHERE day >= date('now', ?)`).get(`-${days} days`)).n;
  const body = `<div class="bar">${[7, 30, 90].map((d) => `<a class="btn ${d === days ? '' : 'gh'} sm" href="?days=${d}">${d} ${esc(L('يوم', 'jours'))}</a>`).join(' ')}</div><div class="cards"><div class="box"><b>${num(sum, lang)}</b><span>${esc(L('مشاهدات الفترة', 'Vues sur la période'))}</span></div></div>
<div class="two"><div class="box"><h3>${esc(L('الأكثر قراءة', 'Articles les plus lus'))}</h3>${K.table([L('المقال', 'Article'), L('المشاهدات', 'Vues')], top.map((t) => `<tr><td><a href="/admin/articles/${t.id}">${esc(t.title)}</a></td><td>${num(t.views, lang)}</td></tr>`))}</div>
<div class="sidebar-stack"><div class="box"><h3>${esc(L('حسب التصنيف', 'Par catégorie'))}</h3>${K.table([L('التصنيف', 'Catégorie'), L('المشاهدات', 'Vues')], cat.map((t) => `<tr><td>${esc(t.name)}</td><td>${num(t.views, lang)}</td></tr>`))}</div>
<div class="box"><h3>${esc(L('أفضل الكتّاب', 'Meilleurs auteurs'))}</h3>${K.table([L('الكاتب', 'Auteur'), L('مقالات', 'Articles'), L('المشاهدات', 'Vues')], auth_.map((t) => `<tr><td>${esc((lang === 'ar' ? t.name_ar : t.name_fr) || t.username)}</td><td>${t.n}</td><td>${num(t.views, lang)}</td></tr>`))}</div></div></div>`;
  res.send(K.shell(c, { title: L('الإحصاءات', 'Statistiques'), active: 'analytics', body }));
});

// ================= PROFILE =================
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxImageBytes, files: 1 } });
async function profile(req, res, err) {
  const c = K.ctxFor(req), { L } = c;
  const u = (await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  const body = `${u.must_change_password ? `<div class="flash err">${esc(L('يجب تغيير كلمة المرور المؤقتة قبل المتابعة.', 'Vous devez changer votre mot de passe temporaire avant de continuer.'))}</div>` : ''}${err ? `<div class="flash err">${esc(L(...(K.ERR[err] || K.ERR.invalid)))}</div>` : ''}
<div class="two"><form method="post" enctype="multipart/form-data" class="box f" action="/admin/profile?_csrf=${encodeURIComponent(c.csrf)}"><h3>${esc(L('ملفي الشخصي', 'Mon profil'))}</h3>
<label>${esc(L('الاسم (عربي)', 'Nom (AR)'))}<input name="name_ar" dir="rtl" value="${esc(u.name_ar)}" maxlength="80"></label><label>${esc(L('الاسم (فرنسي)', 'Nom (FR)'))}<input name="name_fr" value="${esc(u.name_fr)}" maxlength="80"></label>
<label>${esc(L('نبذة (عربي)', 'Bio (AR)'))}<textarea name="bio_ar" dir="rtl" rows="3" maxlength="500">${esc(u.bio_ar)}</textarea></label><label>${esc(L('نبذة (فرنسي)', 'Bio (FR)'))}<textarea name="bio_fr" rows="3" maxlength="500">${esc(u.bio_fr)}</textarea></label>
<label>${esc(L('الصورة الشخصية', 'Photo'))}<input type="file" name="avatar" accept="image/*"></label><div><button class="btn">${esc(L('حفظ', 'Enregistrer'))}</button></div></form>
<form method="post" class="box f" action="/admin/profile/password">${K.csrfField(c)}<h3>${esc(L('تغيير كلمة المرور', 'Changer le mot de passe'))}</h3>
<label>${esc(L('الحالية', 'Actuel'))}<input type="password" name="current" required autocomplete="current-password"></label><label>${esc(L('الجديدة (10 أحرف على الأقل)', 'Nouveau (10 caractères min.)'))}<input type="password" name="password" required minlength="10" autocomplete="new-password"></label><div><button class="btn">${esc(L('تغيير', 'Changer'))}</button></div></form></div>`;
  res.send(K.shell(c, { title: L('ملفي الشخصي', 'Mon profil'), active: '', body }));
}
router.get('/profile', async (req, res) => (await profile(req, res)));
router.post('/profile', (req, res) => {
  avatarUpload.single('avatar')(req, res, async (e) => {
    if (e) return (await profile(req, res, 'too_large'));
    const b = req.body || {};
    let avatar = null;
    if (req.file) {
      try { const m = await M.saveUpload(req.file, req.user.id, 'avatars'); if (m.kind !== 'image') throw new Error('x'); avatar = m.thumb || m.file; }
      catch { return (await profile(req, res, 'unsupported')); }
    }
    (await db.prepare(`UPDATE users SET name_ar=@a, name_fr=@f, bio_ar=@ba, bio_fr=@bf, avatar=COALESCE(@av, avatar), updated_at=datetime('now') WHERE id=@id`)
      .run({ a: text(b.name_ar).slice(0, 80), f: text(b.name_fr).slice(0, 80), ba: text(b.bio_ar).slice(0, 500), bf: text(b.bio_fr).slice(0, 500), av: avatar, id: req.user.id }));
    (await audit(req, 'profile.update', 'user', req.user.id));
    res.redirect('/admin/profile?m=saved');
  });
});
router.post('/profile/password', async (req, res) => {
  const u = (await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  if (!auth.verifyPassword(req.body.current || '', u.password_hash)) return (await profile(req, res, 'wrong_password'));
  const pe = auth.checkPasswordPolicy(req.body.password || '');
  if (pe) return (await profile(req, res, pe));
  (await db.prepare("UPDATE users SET password_hash=?, must_change_password=0, updated_at=datetime('now') WHERE id=?").run(auth.hashPassword(req.body.password), u.id));
  // invalidate other sessions
  const cur = require('../../lib/util').sha256(auth.parseCookies(req)[auth.COOKIE] || '');
  (await db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(u.id, cur));
  (await audit(req, 'user.change_password', 'user', u.id));
  res.redirect('/admin/profile?m=pw_changed');
});

// ================= SETTINGS =================
const HOME_SECTIONS = [
  ['hero', ['الخبر الرئيسي والمميزة', 'À la une']], ['latest', ['آخر الأخبار', 'Dernières actualités']], ['popular', ['الأكثر قراءة', 'Les plus lus']], ['trending', ['الأكثر تداولاً', 'Tendances']],
  ['categories', ['أقسام التصنيفات', 'Sections par catégorie']], ['interviews', ['حوارات', 'Interviews']], ['investigations', ['تحقيقات', 'Enquêtes']], ['opinions', ['مقالات وآراء', 'Opinions']], ['videos', ['فيديو', 'Vidéos']],
];
const uploadAssets = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxImageBytes, files: 2 } });
function settingsPage(req, res, err) {
  const c = K.ctxFor(req), { L } = c, s = settings.all();
  const on = new Set(s.home_sections.split(',')), order = s.home_sections.split(',').filter((k) => HOME_SECTIONS.some((h) => h[0] === k));
  const sorted = [...order, ...HOME_SECTIONS.map((h) => h[0]).filter((k) => !order.includes(k))];
  const inp = (k, label, extra = '') => `<label>${esc(label)}<input name="${k}" value="${esc(s[k])}" ${extra}></label>`;
  const chk = (k, label) => `<label class="chk"><input type="checkbox" name="${k}" value="1" ${s[k] === '1' ? 'checked' : ''}> ${esc(label)}</label>`;
  const body = `${err ? `<div class="flash err">${esc(L(...(K.ERR[err] || K.ERR.invalid)))}</div>` : ''}
<form method="post" enctype="multipart/form-data" class="f" action="/admin/settings?_csrf=${encodeURIComponent(c.csrf)}">
<div class="box f"><h3>${esc(L('الموقع', 'Site'))}</h3><div class="row2">${inp('site_name_ar', L('اسم الموقع (عربي)', 'Nom (AR)'), 'dir="rtl"')}${inp('site_name_fr', L('اسم الموقع (فرنسي)', 'Nom (FR)'))}</div>
<label>${esc(L('الوصف (عربي)', 'Description (AR)'))}<textarea name="description_ar" rows="2" dir="rtl">${esc(s.description_ar)}</textarea></label><label>${esc(L('الوصف (فرنسي)', 'Description (FR)'))}<textarea name="description_fr" rows="2">${esc(s.description_fr)}</textarea></label>
<div class="row2"><label>${esc(L('الشعار', 'Logo'))} <img src="${esc(s.logo)}" alt="" width="40"><input type="file" name="logo" accept="image/*"></label><label>${esc(L('أيقونة الموقع', 'Favicon'))} <img src="${esc(s.favicon)}" alt="" width="24"><input type="file" name="favicon" accept="image/*"></label></div>
<div class="row2"><label>${esc(L('اللون الأساسي', 'Couleur principale'))}<input type="color" name="color_primary" value="${esc(s.color_primary)}"></label><label>${esc(L('اللون الداكن', 'Couleur foncée'))}<input type="color" name="color_primary_dark" value="${esc(s.color_primary_dark)}"></label></div></div>
<div class="box f"><h3>${esc(L('التواصل والشبكات', 'Contact & réseaux'))}</h3><div class="row2">${inp('contact_email', L('البريد', 'E-mail'), 'type="email"')}${inp('phone', L('الهاتف', 'Téléphone'))}${['facebook', 'x', 'youtube', 'instagram', 'whatsapp'].map((k) => inp('social_' + k, k, 'type="url" placeholder="https://"')).join('')}</div></div>
<div class="box f"><h3>${esc(L('اللغات', 'Langues'))}</h3><div class="row2"><label>${esc(L('اللغة الافتراضية', 'Langue par défaut'))}<select name="default_lang"><option value="ar" ${s.default_lang === 'ar' ? 'selected' : ''}>العربية</option><option value="fr" ${s.default_lang === 'fr' ? 'selected' : ''}>Français</option></select></label>
<div><label class="chk"><input type="checkbox" name="lang_ar" value="1" ${s.available_langs.includes('ar') ? 'checked' : ''}> العربية</label><label class="chk"><input type="checkbox" name="lang_fr" value="1" ${s.available_langs.includes('fr') ? 'checked' : ''}> Français</label></div></div></div>
<div class="box f"><h3>${esc(L('أقسام الصفحة الرئيسية', 'Sections de l’accueil'))}</h3><p class="meta-line">${esc(L('الرقم = الترتيب', 'Numéro = ordre d’affichage'))}</p>${sorted.map((k, i) => `<label class="chk"><input type="number" name="ord_${k}" value="${i + 1}" style="width:60px"><input type="checkbox" name="sec_${k}" value="1" ${on.has(k) ? 'checked' : ''}> ${esc(L(...HOME_SECTIONS.find((h) => h[0] === k)[1]))}</label>`).join('')}</div>
<div class="box f"><h3>SEO</h3><label>${esc(L('كلمات مفتاحية (عربي)', 'Mots-clés (AR)'))}<input name="seo_keywords_ar" value="${esc(s.seo_keywords_ar)}" dir="rtl"></label><label>${esc(L('كلمات مفتاحية (فرنسي)', 'Mots-clés (FR)'))}<input name="seo_keywords_fr" value="${esc(s.seo_keywords_fr)}"></label></div>
<div class="box f"><h3>${esc(L('الإعلانات والتعليقات والعاجل', 'Publicité, commentaires, urgent'))}</h3>${chk('ads_enabled', L('تفعيل الإعلانات', 'Activer les publicités'))}${chk('comments_enabled', L('تفعيل التعليقات', 'Activer les commentaires'))}
<div class="row2"><label>${esc(L('وضع التعليقات', 'Mode des commentaires'))}<select name="comments_mode"><option value="moderated" ${s.comments_mode === 'moderated' ? 'selected' : ''}>${esc(L('مراجعة مسبقة', 'Modération préalable'))}</option><option value="open" ${s.comments_mode === 'open' ? 'selected' : ''}>${esc(L('نشر مباشر', 'Publication directe'))}</option></select></label>${inp('comments_max_links', L('أقصى عدد روابط في التعليق', 'Liens max. par commentaire'), 'type="number" min="0" max="5"')}</div>
<label>${esc(L('كلمات محظورة (مفصولة بفاصلة)', 'Mots interdits (séparés par des virgules)'))}<input name="comments_banned_words" value="${esc(s.comments_banned_words)}"></label>
${chk('breaking_enabled', L('تفعيل شريط العاجل', 'Activer le bandeau urgent'))}<div class="row2"><label>${esc(L('مصدر الشريط', 'Source du bandeau'))}<select name="breaking_mode"><option value="flagged" ${s.breaking_mode === 'flagged' ? 'selected' : ''}>${esc(L('الأخبار المعلّمة عاجلاً', 'Articles marqués urgents'))}</option><option value="latest" ${s.breaking_mode === 'latest' ? 'selected' : ''}>${esc(L('أحدث الأخبار', 'Derniers articles'))}</option></select></label>${inp('breaking_count', L('عدد العناصر', 'Nombre d’éléments'), 'type="number" min="1" max="15"')}</div></div>
<div><button class="btn">${esc(L('حفظ الإعدادات', 'Enregistrer'))}</button></div></form>`;
  res.send(K.shell(c, { title: L('إعدادات الموقع', 'Paramètres du site'), active: 'settings', body }));
}
router.get('/settings', need('settings.manage'), (req, res) => settingsPage(req, res));
router.post('/settings', need('settings.manage'), (req, res) => {
  uploadAssets.fields([{ name: 'logo', maxCount: 1 }, { name: 'favicon', maxCount: 1 }])(req, res, async (e) => {
    if (e) return settingsPage(req, res, 'too_large');
    const b = req.body || {};
    const out = {};
    for (const k of ['site_name_ar', 'site_name_fr', 'description_ar', 'description_fr', 'contact_email', 'phone', 'seo_keywords_ar', 'seo_keywords_fr', 'comments_banned_words']) out[k] = text(b[k]).slice(0, 400);
    for (const k of ['facebook', 'x', 'youtube', 'instagram', 'whatsapp']) { const v = String(b['social_' + k] || '').trim(); if (v && !isHttpUrl(v)) return settingsPage(req, res, 'invalid'); out['social_' + k] = v; }
    for (const k of ['color_primary', 'color_primary_dark']) { if (!/^#[0-9a-fA-F]{6}$/.test(b[k] || '')) return settingsPage(req, res, 'invalid'); out[k] = b[k]; }
    if (out.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.contact_email)) return settingsPage(req, res, 'invalid');
    const langs = ['ar', 'fr'].filter((l) => b['lang_' + l]);
    if (!langs.length) return settingsPage(req, res, 'invalid');
    out.available_langs = langs.join(',');
    out.default_lang = langs.includes(b.default_lang) ? b.default_lang : langs[0];
    out.home_sections = HOME_SECTIONS.map((h) => h[0]).filter((k) => b['sec_' + k]).sort((x, y) => (parseInt(b['ord_' + x], 10) || 99) - (parseInt(b['ord_' + y], 10) || 99)).join(',');
    for (const k of ['ads_enabled', 'comments_enabled', 'breaking_enabled']) out[k] = b[k] ? '1' : '0';
    out.comments_mode = b.comments_mode === 'open' ? 'open' : 'moderated';
    out.breaking_mode = b.breaking_mode === 'latest' ? 'latest' : 'flagged';
    out.comments_max_links = String(Math.min(5, Math.max(0, parseInt(b.comments_max_links, 10) || 0)));
    out.breaking_count = String(Math.min(15, Math.max(1, parseInt(b.breaking_count, 10) || 5)));
    for (const k of ['logo', 'favicon']) {
      const f = req.files?.[k]?.[0];
      if (f) { try { const m = await M.saveUpload(f, req.user.id, 'branding'); if (m.kind === 'image') out[k] = '/uploads/' + (k === 'favicon' ? m.thumb || m.file : m.medium || m.file); } catch { return settingsPage(req, res, 'unsupported'); } }
    }
    (await settings.set(out));
    (await audit(req, 'settings.update', 'settings', '', Object.keys(out).join(',')));
    res.redirect('/admin/settings?m=saved');
  });
});
module.exports = router;
