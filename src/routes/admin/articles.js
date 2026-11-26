'use strict';
const express = require('express');
const db = require('../../db');
const A = require('../../lib/articles');
const content = require('../../lib/content');
const K = require('../../views/admin/kit');
const { esc, toInput, fromInput, num } = require('../../lib/util');
const { articlePath } = require('../../lib/urls');
const router = express.Router();

const guard = (...p) => (req, res, next) => (p.some((x) => req.can(x)) ? next() : res.forbidden());
router.use(guard('articles.create', 'articles.edit_own', 'articles.edit_any', 'articles.review', 'articles.publish'));

const canView = (req, a) => req.can('articles.edit_any') || req.can('articles.review') || req.can('articles.publish') || a.author_id === req.user.id;
const seesAll = (req) => req.can('articles.edit_any') || req.can('articles.review') || req.can('articles.publish');
const backWith = (res, id, key, val) => res.redirect(`/admin/articles/${id}?${key}=${val}`);

function run(fn) {
  return async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    try {
      const msg = await fn(req, id);
      res.redirect(`/admin/articles/${id}?m=${msg || 'done'}`);
    } catch (e) {
      if (e instanceof A.Denied) return res.forbidden();
      if (e instanceof A.Invalid) return backWith(res, id, 'e', e.message);
      next(e);
    }
  };
}

// ---------- list ----------
router.get('/', async (req, res) => {
  const c = K.ctxFor(req), { L, lang } = c;
  const status = Object.keys(K.STATUS_LABEL).includes(req.query.status) ? req.query.status : '';
  const q = String(req.query.q || '').trim().slice(0, 80);
  const cat = parseInt(req.query.category, 10) || 0;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1), per = 20;
  const w = ['1=1'], p = {};
  if (!seesAll(req)) { w.push('a.author_id = @me'); p.me = req.user.id; }
  if (status) { w.push('a.status = @st'); p.st = status; }
  if (cat) { w.push('a.category_id = @cat'); p.cat = cat; }
  if (q) { w.push(`EXISTS (SELECT 1 FROM article_translations t WHERE t.article_id = a.id AND t.title LIKE @q)`); p.q = `%${q.replace(/[%_\\]/g, '')}%`; }
  const where = w.join(' AND ');
  const total = (await db.prepare(`SELECT COUNT(*) n FROM articles a WHERE ${where}`).get(p)).n;
  const rows = (await db.prepare(`SELECT a.*, u.name_ar au_ar, u.name_fr au_fr, ct.name cat_name,
      (SELECT title FROM article_translations WHERE article_id = a.id AND lang = @lang) t_here, (SELECT title FROM article_translations WHERE article_id = a.id ORDER BY lang LIMIT 1) t_any,
      (SELECT group_concat(lang) FROM article_translations WHERE article_id = a.id) langs
    FROM articles a LEFT JOIN users u ON u.id = a.author_id JOIN category_translations ct ON ct.category_id = a.category_id AND ct.lang = @lang
    WHERE ${where} ORDER BY a.updated_at DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).all({ ...p, lang }));
  const cats = (await db.prepare('SELECT c.id, ct.name FROM categories c JOIN category_translations ct ON ct.category_id = c.id AND ct.lang = ? ORDER BY c.sort_order').all(lang));
  const counts = Object.fromEntries((await db.prepare(`SELECT status, COUNT(*) n FROM articles a WHERE ${seesAll(req) ? '1=1' : 'a.author_id = ' + Number(req.user.id)} GROUP BY status`).all()).map((r) => [r.status, r.n]));
  const tabs = ['', ...Object.keys(K.STATUS_LABEL)].map((s) => `<a class="btn ${s === status ? '' : 'gh'} sm" href="/admin/articles?status=${s}">${esc(s ? L(...K.STATUS_LABEL[s]) : L('الكل', 'Tous'))}${s ? ` (${counts[s] || 0})` : ''}</a>`).join(' ');
  const pages = Math.max(1, Math.ceil(total / per));
  const qs = (n) => `/admin/articles?${new URLSearchParams({ status, q, category: cat || '', page: n }).toString()}`;
  const body = `<div class="bar">${req.can('articles.create') ? `<a class="btn" href="/admin/articles/new">+ ${esc(L('مقال جديد', 'Nouvel article'))}</a>` : ''}${tabs}</div>
<form class="bar" method="get"><input type="hidden" name="status" value="${esc(status)}"><input name="q" value="${esc(q)}" placeholder="${esc(L('بحث في العناوين…', 'Rechercher un titre…'))}"><select name="category"><option value="">${esc(L('كل التصنيفات', 'Toutes catégories'))}</option>${cats.map((x) => `<option value="${x.id}" ${x.id === cat ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select><button class="btn sm">${esc(L('تصفية', 'Filtrer'))}</button></form>
${K.table([L('العنوان', 'Titre'), L('الحالة', 'Statut'), L('التصنيف', 'Catégorie'), L('الكاتب', 'Auteur'), L('اللغات', 'Langues'), L('المشاهدات', 'Vues'), L('آخر تعديل', 'Modifié')],
    rows.map((r) => `<tr><td data-l="${esc(L('العنوان', 'Titre'))}"><a href="/admin/articles/${r.id}"><b>${esc(r.t_here || r.t_any || '#' + r.id)}</b></a>${r.featured_slot ? ` <span class="badge">★</span>` : ''}${r.is_breaking ? ` <span class="badge st-rejected">${esc(L('عاجل', 'Urgent'))}</span>` : ''}</td><td>${K.badge(c, r.status)}</td><td>${esc(r.cat_name)}</td><td>${esc(lang === 'ar' ? r.au_ar || r.au_fr : r.au_fr || r.au_ar)}</td><td>${esc(String(r.langs || '').toUpperCase().replace(',', ' · '))}</td><td>${num(r.view_count, lang)}</td><td>${K.dt(c, r.updated_at)}</td></tr>`)).replace('<table>', '<table class="resp">')}
<div class="pager">${page > 1 ? `<a href="${qs(page - 1)}">‹</a>` : ''}<span class="cur">${page} / ${pages}</span>${page < pages ? `<a href="${qs(page + 1)}">›</a>` : ''}</div>`;
  res.send(K.shell(c, { title: L('المقالات', 'Articles'), active: 'articles', body }));
});

// ---------- form ----------
async function formPage(req, res, art, values, errKey) {
  const c = K.ctxFor(req), { L, lang } = c;
  const isNew = !art;
  const tr = art ? (await A.translations(art.id)) : {};
  const v = (k, d = '') => (values && k in values ? values[k] : d);
  const val = (l, f) => v(`${f}_${l}`, tr[l] ? tr[l][f] : '');
  const cats = (await db.prepare('SELECT c.id, ct.name FROM categories c JOIN category_translations ct ON ct.category_id = c.id AND ct.lang = ? ORDER BY c.sort_order').all(lang));
  const image = art && art.image_id ? (await db.prepare('SELECT * FROM media WHERE id = ?').get(art.image_id)) : null;
  const imgId = v('image_id', art?.image_id || '');
  const imgRow = imgId ? (await db.prepare('SELECT * FROM media WHERE id = ?').get(imgId)) : null;
  const tagNames = async (l) => (art ? (await db.prepare('SELECT tt.name FROM article_tags at JOIN tag_translations tt ON tt.tag_id = at.tag_id AND tt.lang = ? WHERE at.article_id = ?').all(l, art.id)).map((r) => r.name).join(', ') : '');
  const authors = req.can('articles.edit_any') ? (await db.prepare(`SELECT id, name_ar, name_fr, username FROM users WHERE is_active = 1 ORDER BY name_ar`).all()) : [];
  const editable = isNew || A.canEdit(req, art);
  const dis = editable ? '' : 'disabled';

  const pane = async (l, on) => {
    const dir = l === 'ar' ? 'rtl' : 'ltr';
    const en = values ? values[`enabled_${l}`] === '1' : tr[l] ? !!tr[l].is_enabled : true; // an unchecked box is absent from the POST body
    return `<div class="pane ${on ? 'on' : ''}" dir="${dir}">
<label>${l === 'ar' ? 'العنوان' : 'Titre'}<input name="title_${l}" value="${esc(val(l, 'title'))}" maxlength="250" ${dis} ${l === 'ar' ? 'lang="ar"' : 'lang="fr"'}></label>
<label>${l === 'ar' ? 'الملخص' : 'Résumé'}<textarea name="summary_${l}" rows="3" maxlength="600" ${dis}>${esc(val(l, 'summary'))}</textarea></label>
<label>${l === 'ar' ? 'المحتوى' : 'Contenu'}</label>
${editable ? `<div class="ed-tb" aria-label="editor"><button type="button" data-c="h2">H2</button><button type="button" data-c="h3">H3</button><button type="button" data-c="p">¶</button><button type="button" data-c="bold"><b>B</b></button><button type="button" data-c="italic"><i>I</i></button><button type="button" data-c="underline"><u>U</u></button><button type="button" data-c="insertUnorderedList">• ${l === 'ar' ? 'قائمة' : 'Liste'}</button><button type="button" data-c="insertOrderedList">1.</button><button type="button" data-c="quote">❝</button><button type="button" data-c="link">🔗</button><button type="button" data-c="unlink">⛓</button><button type="button" data-c="img">🖼 ${l === 'ar' ? 'صورة' : 'Image'}</button><button type="button" data-c="video">▶ ${l === 'ar' ? 'فيديو' : 'Vidéo'}</button><button type="button" data-c="removeFormat">✕</button></div>
<div class="ed" contenteditable="true" data-for="content_${l}" dir="${dir}" lang="${l}"></div>` : `<div class="ed">${val(l, 'content')}</div>`}
<textarea id="content_${l}" name="content_${l}" hidden>${esc(val(l, 'content'))}</textarea>
<div class="row2"><label>SEO ${l === 'ar' ? 'العنوان' : 'Title'}<input name="seo_title_${l}" value="${esc(val(l, 'seo_title'))}" maxlength="120" ${dis}></label>
<label>SEO ${l === 'ar' ? 'الوصف' : 'Description'}<input name="seo_description_${l}" value="${esc(val(l, 'seo_description'))}" maxlength="300" ${dis}></label></div>
<label>${l === 'ar' ? 'الوسوم (مفصولة بفاصلة)' : 'Mots-clés (séparés par des virgules)'}<input name="tags_${l}" value="${esc(v(`tags_${l}`, (await tagNames(l))))}" ${dis}></label>
<label class="chk"><input type="checkbox" name="enabled_${l}" value="1" ${en ? 'checked' : ''} ${dis}> ${esc(L(l === 'ar' ? 'نشر النسخة العربية' : 'نشر النسخة الفرنسية', l === 'ar' ? 'Publier la version arabe' : 'Publier la version française'))}</label></div>`;
  };

  const form = `<form method="post" class="f" data-editor action="${isNew ? '/admin/articles' : `/admin/articles/${art.id}/save`}">${K.csrfField(c)}
<div class="box" data-tabs><div class="tabs" role="tablist"><button type="button" class="on">العربية</button><button type="button">Français</button></div>${(await pane('ar', true))}${(await pane('fr', false))}</div>
<div class="box"><h3>${esc(L('الإعدادات', 'Paramètres'))}</h3><div class="row2">
<label>${esc(L('التصنيف', 'Catégorie'))}<select name="category_id" ${dis}>${cats.map((x) => `<option value="${x.id}" ${String(v('category_id', art?.category_id)) === String(x.id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
<label>${esc(L('النوع', 'Type'))}<select name="type" ${dis}>${A.TYPES.map((x) => `<option value="${x}" ${v('type', art?.type || 'news') === x ? 'selected' : ''}>${esc({ news: L('خبر', 'Actualité'), opinion: L('رأي/تحليل', 'Opinion/analyse'), interview: L('حوار', 'Interview'), investigation: L('تحقيق', 'Enquête'), video: L('فيديو', 'Vidéo') }[x])}</option>`).join('')}</select></label>
<label>${esc(L('رابط فيديو (يوتيوب/فيميو)', 'Lien vidéo (YouTube/Vimeo)'))}<input name="video_url" value="${esc(v('video_url', art?.video_url || ''))}" ${dis} placeholder="https://"></label>
<label>${esc(L('توقيع الكاتب (اختياري)', 'Signature (facultatif)'))}<input name="author_label" value="${esc(v('author_label', art?.author_label || ''))}" maxlength="120" ${dis}></label>
${authors.length ? `<label>${esc(L('الكاتب', 'Auteur'))}<select name="author_id">${authors.map((u) => `<option value="${u.id}" ${(+v('author_id', art?.author_id || req.user.id)) === u.id ? 'selected' : ''}>${esc((lang === 'ar' ? u.name_ar : u.name_fr) || u.username)}</option>`).join('')}</select></label>` : ''}
${req.can('articles.schedule') || req.can('articles.publish') ? `<label>${esc(L('تاريخ النشر المجدول (UTC)', 'Publication programmée (UTC)'))}<input type="datetime-local" name="publish_at" value="${esc(v('publish_at', toInput(art?.publish_at)))}"></label>` : ''}</div>
<div class="pick" data-pick="image" style="margin-block:10px"><input type="hidden" name="image_id" value="${esc(imgId)}"><img src="${imgRow ? '/uploads/' + esc(imgRow.thumb || imgRow.file) : ''}" alt="" style="${imgRow ? '' : 'display:none'}">${editable ? `<button type="button" class="btn gh sm" data-open>${esc(L('اختيار الصورة البارزة', 'Choisir l’image à la une'))}</button> <button type="button" class="btn gh sm" data-clear>✕</button>` : ''}</div>
<label class="chk"><input type="checkbox" name="comments_enabled" value="1" ${(values ? values.comments_enabled === '1' : art ? art.comments_enabled : true) ? 'checked' : ''} ${dis}> ${esc(L('السماح بالتعليقات', 'Autoriser les commentaires'))}</label></div>
${editable ? `<button class="btn">${esc(L('حفظ', 'Enregistrer'))}</button>` : ''}</form>
<div id="mediaModal" class="modal"><div class="in"><div class="bar"><input id="mediaSearch" placeholder="${esc(L('بحث…', 'Rechercher…'))}"><label class="btn gh sm" style="cursor:pointer">${esc(L('رفع صورة', 'Téléverser'))}<input id="mediaUpload" type="file" accept="image/*" multiple hidden></label><span style="flex:1"></span><button type="button" class="btn gh sm" data-mclose>✕</button></div><div id="mediaGrid" class="mgrid"></div></div></div>`;

  let side = '';
  if (art) {
    const s = art.status, a = [];
    const act = (path, label, cls = 'btn', extra = '', confirm = '') => `<form method="post" action="/admin/articles/${art.id}/${path}" class="inline" ${confirm ? `data-confirm="${esc(confirm)}"` : ''}>${K.csrfField(c)}${extra}<button class="${cls} sm">${esc(label)}</button></form>`;
    if (['draft', 'rejected'].includes(s) && req.can('articles.submit') && (art.author_id === req.user.id || req.can('articles.edit_any'))) a.push(act('submit', L('إرسال للمراجعة', 'Soumettre pour relecture'), 'btn warn'));
    if (s === 'pending' && req.can('articles.review')) {
      a.push(act('approve', L('موافقة', 'Approuver'), 'btn ok'));
      a.push(`<form method="post" action="/admin/articles/${art.id}/reject" class="inline">${K.csrfField(c)}<input name="note" placeholder="${esc(L('سبب الرفض', 'Motif du refus'))}" maxlength="500"> <button class="btn dg sm">${esc(L('رفض', 'Refuser'))}</button></form>`);
    }
    if (s !== 'published' && s !== 'archived' && req.can('articles.publish')) a.push(act('publish', L('نشر الآن', 'Publier maintenant'), 'btn ok', '', L('نشر المقال الآن؟', 'Publier maintenant ?')));
    if (!['published', 'archived'].includes(s) && req.can('articles.schedule')) a.push(`<form method="post" action="/admin/articles/${art.id}/schedule" class="inline">${K.csrfField(c)}<input type="datetime-local" name="publish_at" value="${esc(toInput(art.publish_at))}" required> <button class="btn sm">${esc(L('جدولة', 'Programmer'))}</button></form>`);
    if (['published', 'scheduled'].includes(s) && req.can('articles.publish')) a.push(act('unpublish', L('إلغاء النشر', 'Dépublier'), 'btn gh', '', L('إلغاء نشر المقال؟', 'Dépublier ?')));
    if (s !== 'archived' && req.can('articles.archive')) a.push(act('archive', L('أرشفة', 'Archiver'), 'btn gh'));
    if (s === 'archived' && req.can('articles.archive')) a.push(act('restore', L('استعادة', 'Restaurer'), 'btn gh'));
    if (req.can('articles.delete') || (art.author_id === req.user.id && s === 'draft' && req.can('articles.edit_own'))) a.push(act('delete', L('حذف', 'Supprimer'), 'btn dg', '', L('حذف المقال نهائياً؟', 'Supprimer définitivement ?')));
    let feat = '';
    if (req.can('articles.feature') && s === 'published') {
      feat = `<form method="post" action="/admin/articles/${art.id}/feature" class="f box">${K.csrfField(c)}<h3>${esc(L('الواجهة', 'Mise en avant'))}</h3><label>${esc(L('موقع الظهور', 'Emplacement'))}<select name="slot"><option value="">${esc(L('بدون', 'Aucun'))}</option><option value="main" ${art.featured_slot === 'main' ? 'selected' : ''}>${esc(L('الخبر الرئيسي', 'Titre principal'))}</option><option value="secondary" ${art.featured_slot === 'secondary' ? 'selected' : ''}>${esc(L('خبر ثانوي', 'Secondaire'))}</option></select></label><label class="chk"><input type="checkbox" name="breaking" value="1" ${art.is_breaking ? 'checked' : ''}> ${esc(L('شريط العاجل', 'Bandeau urgent'))}</label><button class="btn sm">${esc(L('تطبيق', 'Appliquer'))}</button></form>`;
    }
    const first = (await db.prepare("SELECT lang, slug FROM article_translations WHERE article_id = ? ORDER BY lang LIMIT 1").get(art.id));
    const live = s === 'published' ? (await content.availableLangs(art.id)) : null;
    side = `<div class="box"><h3>${K.badge(c, s)}</h3>
${art.review_note ? `<div class="flash err"><b>${esc(L('ملاحظة المحرر', 'Note du rédacteur'))}:</b> ${esc(art.review_note)}</div>` : ''}
<p class="meta-line">${esc(L('أُنشئ', 'Créé'))}: ${K.dt(c, art.created_at)}<br>${esc(L('عُدّل', 'Modifié'))}: ${K.dt(c, art.updated_at)}${art.published_at ? `<br>${esc(L('نُشر', 'Publié'))}: ${K.dt(c, art.published_at)}` : ''}${art.publish_at ? `<br>${esc(L('مجدول', 'Programmé'))}: ${K.dt(c, art.publish_at)} UTC` : ''}<br>${num(art.view_count, lang)} ${esc(L('مشاهدة', 'vues'))}</p>
<div style="display:grid;gap:8px">${a.join('')}</div>
${live ? Object.entries(live).map(([l, sl]) => `<p><a href="${articlePath(l, { id: art.id, slug: sl })}" target="_blank" rel="noopener">${l.toUpperCase()} ↗</a></p>`).join('') : ''}
<p><a href="/admin/articles/${art.id}/revisions">${esc(L('سجل المراجعات', 'Historique des révisions'))}</a></p></div>${feat}`;
  }
  const flashErr = errKey ? `<div class="flash err" role="alert">${esc(L(...(K.ERR[errKey] || K.ERR.invalid)))}</div>` : '';
  const html = K.shell(c, { title: isNew ? L('مقال جديد', 'Nouvel article') : L('تحرير المقال', 'Modifier l’article'), active: 'articles', back: '/admin/articles',
    body: `${flashErr}<div class="two"><div>${form}</div><div class="sidebar-stack">${side}</div></div>` });
  res.send(html);
}

router.get('/new', guard('articles.create'), async (req, res) => (await formPage(req, res, null, null, null)));
router.post('/', async (req, res, next) => {
  try {
    const id = (await A.save(req, null, normalize(req.body)));
    res.redirect(`/admin/articles/${id}?m=saved`);
  } catch (e) {
    if (e instanceof A.Denied) return res.forbidden();
    if (e instanceof A.Invalid) return (await formPage(req, res, null, req.body, e.message));
    next(e);
  }
});
const normalize = (b) => ({ ...b, enabled_ar: b.enabled_ar ? '1' : '0', enabled_fr: b.enabled_fr ? '1' : '0', comments_enabled: b.comments_enabled ? '1' : '0', publish_at: fromInput(b.publish_at) });

router.get('/:id', async (req, res, next) => {
  const art = (await A.getRow(parseInt(req.params.id, 10)));
  if (!art) return next();
  if (!canView(req, art)) return res.forbidden();
  (await formPage(req, res, art, null, req.query.e && !K.ERR[req.query.e] ? 'invalid' : null));
});
router.post('/:id/save', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  try {
    (await A.save(req, id, normalize(req.body)));
    res.redirect(`/admin/articles/${id}?m=saved`);
  } catch (e) {
    if (e instanceof A.Denied) return res.forbidden();
    if (e instanceof A.Invalid) return (await formPage(req, res, (await A.getRow(id)), req.body, e.message));
    next(e);
  }
});
router.post('/:id/submit', run(async (req, id) => { (await A.submit(req, id)); return 'submitted'; }));
router.post('/:id/approve', run(async (req, id) => { (await A.approve(req, id)); return 'approved'; }));
router.post('/:id/reject', run(async (req, id) => { (await A.reject(req, id, req.body.note)); return 'rejected'; }));
router.post('/:id/publish', run(async (req, id) => { (await A.publish(req, id)); return 'published'; }));
router.post('/:id/schedule', run(async (req, id) => { (await A.schedule(req, id, fromInput(req.body.publish_at))); return 'scheduled'; }));
router.post('/:id/unpublish', run(async (req, id) => { (await A.unpublish(req, id)); return 'unpublished'; }));
router.post('/:id/archive', run(async (req, id) => { (await A.archive(req, id)); return 'archived'; }));
router.post('/:id/restore', run(async (req, id) => { (await A.restore(req, id)); return 'restored'; }));
router.post('/:id/feature', run(async (req, id) => { (await A.setFeature(req, id, { slot: req.body.slot || null, breaking: req.body.breaking === '1' })); return 'saved'; }));
router.post('/:id/delete', async (req, res, next) => {
  try { (await A.remove(req, parseInt(req.params.id, 10))); res.redirect('/admin/articles?m=deleted'); } catch (e) { if (e instanceof A.Denied) return res.forbidden(); next(e); }
});

router.get('/:id/revisions', async (req, res, next) => {
  const c = K.ctxFor(req), { L } = c;
  const art = (await A.getRow(parseInt(req.params.id, 10)));
  if (!art) return next();
  if (!canView(req, art)) return res.forbidden();
  const revs = (await db.prepare('SELECT r.*, u.username FROM article_revisions r LEFT JOIN users u ON u.id = r.user_id WHERE r.article_id = ? ORDER BY r.id DESC').all(art.id));
  const body = `<div class="box">${K.table(['#', L('التاريخ', 'Date'), L('المستخدم', 'Utilisateur'), L('ملاحظة', 'Note'), ''],
    revs.map((r) => `<tr><td>${r.id}</td><td>${K.dt(c, r.created_at)}</td><td>${esc(r.username || '—')}</td><td>${esc(r.note)}</td><td>${A.canEdit(req, art) ? K.postForm(c, `/admin/articles/${art.id}/revisions/${r.id}/restore`, `<button class="btn gh sm">${esc(L('استعادة هذه النسخة', 'Restaurer'))}</button>`, { confirm: L('استعادة هذه النسخة؟', 'Restaurer cette version ?') }) : ''}</td></tr>`))}</div>`;
  res.send(K.shell(c, { title: L('سجل المراجعات', 'Historique des révisions'), active: 'articles', back: `/admin/articles/${art.id}`, body }));
});
router.post('/:id/revisions/:rid/restore', run(async (req, id) => { (await A.restoreRevision(req, id, parseInt(req.params.rid, 10))); return 'restored'; }));

module.exports = router;
