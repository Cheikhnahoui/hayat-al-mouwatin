'use strict';
const express = require('express');
const db = require('../../db');
const K = require('../../views/admin/kit');
const { esc, slugify } = require('../../lib/util');
const { text } = require('../../lib/sanitize');
const { audit } = require('../../lib/audit');
const router = express.Router();

const need = (p) => (req, res, next) => (req.can(p) ? next() : res.forbidden());
const mediaPicker = async (c, imgId, name = 'image_id') => {
  const m = imgId ? (await db.prepare('SELECT * FROM media WHERE id = ?').get(imgId)) : null;
  return `<div class="pick" data-pick="image"><input type="hidden" name="${name}" value="${esc(imgId || '')}"><img src="${m ? '/uploads/' + esc(m.thumb || m.file) : ''}" alt="" style="${m ? '' : 'display:none'}"><button type="button" class="btn gh sm" data-open>${esc(c.L('اختيار صورة', 'Choisir une image'))}</button> <button type="button" class="btn gh sm" data-clear>✕</button></div>`;
};
const modal = (c) => `<div id="mediaModal" class="modal"><div class="in"><div class="bar"><input id="mediaSearch" placeholder="${esc(c.L('بحث…', 'Rechercher…'))}"><label class="btn gh sm" style="cursor:pointer">${esc(c.L('رفع', 'Téléverser'))}<input id="mediaUpload" type="file" accept="image/*" multiple hidden></label><span style="flex:1"></span><button type="button" class="btn gh sm" data-mclose>✕</button></div><div id="mediaGrid" class="mgrid"></div></div></div>`;

// ================= CATEGORIES =================
async function catRow(id) {
  const c = (await db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  if (!c) return null;
  c.tr = Object.fromEntries((await db.prepare('SELECT * FROM category_translations WHERE category_id = ?').all(id)).map((t) => [t.lang, t]));
  return c;
}
router.get('/categories', need('categories.manage'), async (req, res) => {
  const c = K.ctxFor(req), { L, lang } = c;
  const rows = (await db.prepare(`SELECT c.*, (SELECT name FROM category_translations WHERE category_id=c.id AND lang='ar') name_ar, (SELECT name FROM category_translations WHERE category_id=c.id AND lang='fr') name_fr,
    (SELECT COUNT(*) FROM articles WHERE category_id = c.id) n FROM categories c ORDER BY c.sort_order, c.id`).all());
  const body = `<p><a class="btn" href="/admin/categories/new">+ ${esc(L('تصنيف جديد', 'Nouvelle catégorie'))}</a></p>
<form method="post" action="/admin/categories/order">${K.csrfField(c)}<div class="box">${K.table([L('الترتيب', 'Ordre'), 'AR', 'FR', L('المقالات', 'Articles'), L('الحالة', 'État'), ''],
    rows.map((r) => `<tr><td><input type="number" name="o_${r.id}" value="${r.sort_order}" style="width:70px"></td><td>${esc(r.name_ar)}</td><td>${esc(r.name_fr)}</td><td>${r.n}</td><td>${r.is_active ? '✔' : '✖'}</td><td><a class="btn gh sm" href="/admin/categories/${r.id}">${esc(L('تعديل', 'Modifier'))}</a></td></tr>`))}<button class="btn sm">${esc(L('حفظ الترتيب', 'Enregistrer l’ordre'))}</button></div></form>`;
  res.send(K.shell(c, { title: L('التصنيفات', 'Catégories'), active: 'categories', body }));
});
router.post('/categories/order', need('categories.manage'), async (req, res) => {
  const st = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
  (await db.transaction(async () => { for (const [k, v] of Object.entries(req.body)) { const m = k.match(/^o_(\d+)$/); if (m) (await st.run(parseInt(v, 10) || 0, +m[1])); } })());
  (await audit(req, 'category.reorder', 'category'));
  res.redirect('/admin/categories?m=saved');
});
async function catForm(req, res, cat, vals, err) {
  const c = K.ctxFor(req), { L } = c;
  const v = (k, d = '') => (vals && k in vals ? vals[k] : d);
  const t = (l, f) => v(`${f}_${l}`, cat?.tr?.[l]?.[f] || '');
  const lp = (l) => `<div class="box"><h3>${l === 'ar' ? 'العربية' : 'Français'}</h3><div dir="${l === 'ar' ? 'rtl' : 'ltr'}" class="f">
<label>${l === 'ar' ? 'الاسم' : 'Nom'}<input name="name_${l}" required value="${esc(t(l, 'name'))}" maxlength="80"></label>
<label>Slug<input name="slug_${l}" value="${esc(t(l, 'slug'))}" maxlength="80"></label>
<label>${l === 'ar' ? 'الوصف' : 'Description'}<textarea name="description_${l}" rows="2" maxlength="300">${esc(t(l, 'description'))}</textarea></label>
<label>SEO ${l === 'ar' ? 'العنوان' : 'Title'}<input name="seo_title_${l}" value="${esc(t(l, 'seo_title'))}" maxlength="120"></label>
<label>SEO ${l === 'ar' ? 'الوصف' : 'Description'}<input name="seo_description_${l}" value="${esc(t(l, 'seo_description'))}" maxlength="300"></label></div></div>`;
  const body = `${err ? `<div class="flash err">${esc(L(...(K.ERR[err] || K.ERR.invalid)))}</div>` : ''}<form method="post" class="f" action="${cat ? `/admin/categories/${cat.id}` : '/admin/categories'}">${K.csrfField(c)}
<div class="two">${lp('ar')}${lp('fr')}</div>
<div class="box f"><div class="row2">${cat ? '' : `<label>${esc(L('المعرّف (إنجليزي)', 'Identifiant (latin)'))}<input name="key" value="${esc(v('key'))}" maxlength="40" pattern="[a-z0-9_-]+"></label>`}
<label>${esc(L('اللون (درجة 0-360)', 'Teinte (0-360)'))}<input type="number" name="hue" min="0" max="360" value="${esc(v('hue', cat?.hue ?? 0))}"></label>
<label>${esc(L('الترتيب', 'Ordre'))}<input type="number" name="sort_order" value="${esc(v('sort_order', cat?.sort_order ?? 99))}"></label></div>
<label class="chk"><input type="checkbox" name="is_active" value="1" ${(vals ? vals.is_active : cat ? cat.is_active : 1) ? 'checked' : ''}> ${esc(L('مفعّل', 'Activée'))}</label>
<label class="chk"><input type="checkbox" name="show_on_home" value="1" ${(vals ? vals.show_on_home : cat ? cat.show_on_home : 1) ? 'checked' : ''}> ${esc(L('عرضه في الصفحة الرئيسية', 'Afficher sur l’accueil'))}</label>
${(await mediaPicker(c, v('image_id', cat?.image_id)))}<div><button class="btn">${esc(L('حفظ', 'Enregistrer'))}</button></div></div></form>
${cat ? K.postForm(c, `/admin/categories/${cat.id}/delete`, `<button class="btn dg sm">${esc(L('حذف التصنيف', 'Supprimer'))}</button>`, { confirm: L('حذف التصنيف؟', 'Supprimer cette catégorie ?') }) : ''}${modal(c)}`;
  res.send(K.shell(c, { title: cat ? L('تعديل تصنيف', 'Modifier la catégorie') : L('تصنيف جديد', 'Nouvelle catégorie'), active: 'categories', back: '/admin/categories', body }));
}
router.get('/categories/new', need('categories.manage'), async (req, res) => (await catForm(req, res, null)));
router.get('/categories/:id', need('categories.manage'), async (req, res, next) => { const cat = (await catRow(+req.params.id)); if (!cat) return next(); (await catForm(req, res, cat)); });
async function saveCat(req, res, id) {
  const b = req.body;
  const out = {};
  for (const l of ['ar', 'fr']) {
    out[l] = { name: text(b[`name_${l}`]).slice(0, 80), slug: slugify(b[`slug_${l}`] || b[`name_${l}`], 80), description: text(b[`description_${l}`]).slice(0, 300), seo_title: text(b[`seo_title_${l}`]).slice(0, 120), seo_description: text(b[`seo_description_${l}`]).slice(0, 300) };
    if (!out[l].name) return { err: 'invalid' };
    const dup = (await db.prepare('SELECT 1 FROM category_translations WHERE lang = ? AND slug = ? AND category_id <> ?').get(l, out[l].slug, id || 0));
    if (dup) return { err: 'exists' };
  }
  const f = { hue: Math.min(360, Math.max(0, parseInt(b.hue, 10) || 0)), sort: parseInt(b.sort_order, 10) || 0, act: b.is_active ? 1 : 0, home: b.show_on_home ? 1 : 0, img: parseInt(b.image_id, 10) || null };
  if (f.img && !(await db.prepare('SELECT 1 FROM media WHERE id = ?').get(f.img))) f.img = null;
  let cid = id;
  try {
    (await db.transaction(async () => {
      if (!cid) {
        const key = slugify(b.key || out.fr.name, 40).replace(/[^a-z0-9_-]/g, '') || 'cat' + Date.now();
        cid = (await db.prepare('INSERT INTO categories (key, hue, image_id, sort_order, is_active, show_on_home) VALUES (?,?,?,?,?,?)').run(key, f.hue, f.img, f.sort, f.act, f.home)).lastInsertRowid;
      } else (await db.prepare('UPDATE categories SET hue=?, image_id=?, sort_order=?, is_active=?, show_on_home=? WHERE id=?').run(f.hue, f.img, f.sort, f.act, f.home, cid));
      for (const l of ['ar', 'fr']) {
        const o = out[l];
        (await db.prepare(`INSERT INTO category_translations (category_id, lang, name, slug, description, seo_title, seo_description) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(category_id, lang) DO UPDATE SET name=excluded.name, slug=excluded.slug, description=excluded.description, seo_title=excluded.seo_title, seo_description=excluded.seo_description`).run(cid, l, o.name, o.slug, o.description, o.seo_title, o.seo_description));
      }
    })());
  } catch (e) { if (/UNIQUE/.test(e.message)) return { err: 'exists' }; throw e; }
  return { id: cid };
}
router.post('/categories', need('categories.manage'), async (req, res) => {
  const r = (await saveCat(req, res, null));
  if (r.err) return (await catForm(req, res, null, req.body, r.err));
  (await audit(req, 'category.create', 'category', r.id)); res.redirect('/admin/categories?m=saved');
});
router.post('/categories/:id', need('categories.manage'), async (req, res, next) => {
  const id = +req.params.id; if (!(await catRow(id))) return next();
  const r = (await saveCat(req, res, id));
  if (r.err) return (await catForm(req, res, (await catRow(id)), req.body, r.err));
  (await audit(req, 'category.update', 'category', id)); res.redirect('/admin/categories?m=saved');
});
router.post('/categories/:id/delete', need('categories.manage'), async (req, res) => {
  const id = +req.params.id;
  if ((await db.prepare('SELECT 1 FROM articles WHERE category_id = ?').get(id))) return res.redirect('/admin/categories?e=in_use');
  await db.prepare('DELETE FROM category_translations WHERE category_id = ?').run(id);
  (await db.prepare('DELETE FROM categories WHERE id = ?').run(id));
  (await audit(req, 'category.delete', 'category', id)); res.redirect('/admin/categories?m=deleted');
});

// ================= TAGS =================
router.get('/tags', need('tags.manage'), async (req, res) => {
  const c = K.ctxFor(req), { L } = c;
  const q = String(req.query.q || '').trim().slice(0, 60);
  const rows = (await db.prepare(`SELECT t.id, (SELECT name FROM tag_translations WHERE tag_id=t.id AND lang='ar') ar, (SELECT name FROM tag_translations WHERE tag_id=t.id AND lang='fr') fr,
    (SELECT COUNT(*) FROM article_tags WHERE tag_id=t.id) n FROM tags t
    WHERE @q = '' OR EXISTS (SELECT 1 FROM tag_translations x WHERE x.tag_id=t.id AND x.name LIKE '%' || @q || '%') ORDER BY t.id DESC LIMIT 200`).all({ q: q.replace(/[%_]/g, '') }));
  const body = `<form class="bar" method="get"><input name="q" value="${esc(q)}" placeholder="${esc(L('بحث…', 'Rechercher…'))}"><button class="btn sm">${esc(L('بحث', 'Chercher'))}</button></form>
<form method="post" action="/admin/tags" class="bar">${K.csrfField(c)}<input name="name_ar" placeholder="AR" dir="rtl"><input name="name_fr" placeholder="FR"><button class="btn sm">+ ${esc(L('وسم', 'Tag'))}</button></form>
<div class="box">${K.table(['AR', 'FR', L('المقالات', 'Articles'), ''], rows.map((r) => `<tr><td colspan="2"><form method="post" action="/admin/tags/${r.id}" class="bar" style="margin:0">${K.csrfField(c)}<input name="name_ar" value="${esc(r.ar || '')}" dir="rtl" placeholder="AR"><input name="name_fr" value="${esc(r.fr || '')}" placeholder="FR"><button class="btn gh sm">${esc(L('حفظ', 'OK'))}</button></form></td><td>${r.n}</td><td>${K.postForm(c, `/admin/tags/${r.id}/delete`, `<button class="btn dg sm">✕</button>`, { confirm: L('حذف الوسم؟', 'Supprimer ce tag ?') })}</td></tr>`))}</div>`;
  res.send(K.shell(c, { title: L('الوسوم', 'Tags'), active: 'tags', body }));
});
async function upsertTag(tagId, lang, name) {
  name = text(name).slice(0, 60);
  if (!name) { (await db.prepare('DELETE FROM tag_translations WHERE tag_id = ? AND lang = ?').run(tagId, lang)); return; }
  let slug = slugify(name, 60), n = 1;
  while ((await db.prepare('SELECT 1 FROM tag_translations WHERE lang = ? AND slug = ? AND tag_id <> ?').get(lang, slug, tagId))) slug = `${slugify(name, 55)}-${++n}`;
  (await db.prepare('INSERT INTO tag_translations (tag_id, lang, name, slug) VALUES (?,?,?,?) ON CONFLICT(tag_id, lang) DO UPDATE SET name = excluded.name, slug = excluded.slug').run(tagId, lang, name, slug));
}
router.post('/tags', need('tags.manage'), async (req, res) => {
  if (!text(req.body.name_ar) && !text(req.body.name_fr)) return res.redirect('/admin/tags?e=invalid');
  (await db.transaction(async () => { const id = (await db.prepare('INSERT INTO tags DEFAULT VALUES').run()).lastInsertRowid; (await upsertTag(id, 'ar', req.body.name_ar)); (await upsertTag(id, 'fr', req.body.name_fr)); })());
  (await audit(req, 'tag.create', 'tag')); res.redirect('/admin/tags?m=saved');
});
router.post('/tags/:id', need('tags.manage'), async (req, res) => {
  const id = +req.params.id;
  if (!(await db.prepare('SELECT 1 FROM tags WHERE id = ?').get(id))) return res.redirect('/admin/tags?e=invalid');
  (await db.transaction(async () => { (await upsertTag(id, 'ar', req.body.name_ar)); (await upsertTag(id, 'fr', req.body.name_fr)); })());
  (await audit(req, 'tag.update', 'tag', id)); res.redirect('/admin/tags?m=saved');
});
router.post('/tags/:id/delete', need('tags.manage'), async (req, res) => {
  for (const tbl of ['article_tags', 'tag_translations']) await db.prepare(`DELETE FROM ${tbl} WHERE tag_id = ?`).run(+req.params.id);
  (await db.prepare('DELETE FROM tags WHERE id = ?').run(+req.params.id));
  (await audit(req, 'tag.delete', 'tag', req.params.id)); res.redirect('/admin/tags?m=deleted');
});

module.exports = router;
