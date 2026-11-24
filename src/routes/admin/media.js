'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../../db');
const config = require('../../config');
const M = require('../../lib/media');
const K = require('../../views/admin/kit');
const { esc } = require('../../lib/util');
const { text } = require('../../lib/sanitize');
const { audit } = require('../../lib/audit');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxVideoBytes, files: 10 } });
const any = (req, res, next) => (req.can('media.upload') || req.can('media.manage') ? next() : res.forbidden());
router.use(any);
const scope = (req) => (req.can('media.manage') ? { sql: '1=1', p: {} } : { sql: 'uploaded_by = @me', p: { me: req.user.id } });

router.get('/list.json', async (req, res) => {
  const s = scope(req);
  const kind = req.query.kind === 'video' ? 'video' : 'image';
  const q = String(req.query.q || '').trim().slice(0, 60).replace(/[%_\\]/g, '');
  // editors may reuse any image when composing articles
  const sql = req.can('media.manage') || req.can('articles.create') || req.can('categories.manage') ? '1=1' : s.sql;
  const rows = (await db.prepare(`SELECT id, file, thumb, medium, original_name, alt_ar, alt_fr, caption_ar, caption_fr FROM media WHERE kind = @kind AND ${sql} ${q ? `AND (original_name LIKE @q OR alt_ar LIKE @q OR alt_fr LIKE @q)` : ''} ORDER BY id DESC LIMIT 60`)
    .all({ kind, q: `%${q}%`, ...s.p }));
  const lang = req.user.ui_lang;
  res.json(rows.map((r) => ({ ...r, alt: lang === 'ar' ? r.alt_ar : r.alt_fr, caption: lang === 'ar' ? r.caption_ar : r.caption_fr })));
});

router.get('/', async (req, res) => {
  const c = K.ctxFor(req), { L } = c;
  const s = scope(req);
  const q = String(req.query.q || '').trim().slice(0, 60).replace(/[%_\\]/g, '');
  const folder = String(req.query.folder || '').slice(0, 40);
  const rows = (await db.prepare(`SELECT * FROM media WHERE ${s.sql} ${q ? 'AND (original_name LIKE @q OR alt_ar LIKE @q OR alt_fr LIKE @q)' : ''} ${folder ? 'AND folder = @f' : ''} ORDER BY id DESC LIMIT 120`).all({ q: `%${q}%`, f: folder, ...s.p }));
  const folders = (await db.prepare(`SELECT DISTINCT folder FROM media WHERE ${s.sql} ORDER BY folder`).all(s.p)).map((r) => r.folder);
  const body = `<form class="bar" method="get"><input name="q" value="${esc(q)}" placeholder="${esc(L('بحث في الوسائط…', 'Rechercher…'))}"><select name="folder"><option value="">${esc(L('كل المجلدات', 'Tous les dossiers'))}</option>${folders.map((f) => `<option ${f === folder ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select><button class="btn sm">${esc(L('بحث', 'Chercher'))}</button></form>
<form method="post" enctype="multipart/form-data" action="/admin/media/upload?_csrf=${encodeURIComponent(c.csrf)}" class="box bar"><input type="file" name="files" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" required><input name="folder" placeholder="${esc(L('المجلد', 'Dossier'))}" value="general" maxlength="40"><button class="btn sm">${esc(L('رفع', 'Téléverser'))}</button><span class="meta-line">${esc(L(`الصور حتى ${config.maxImageBytes / 1048576}MB، الفيديو حتى ${config.maxVideoBytes / 1048576}MB`, `Images ≤ ${config.maxImageBytes / 1048576} Mo, vidéos ≤ ${config.maxVideoBytes / 1048576} Mo`))}</span></form>
<div class="mgrid">${rows.map((m) => `<a class="mi" href="/admin/media/${m.id}">${m.kind === 'image' ? `<img src="/uploads/${esc(m.thumb || m.file)}" alt="${esc(m.alt_ar || m.alt_fr)}" loading="lazy">` : `<video src="/uploads/${esc(m.file)}" preload="metadata" muted></video>`}<div>${esc(m.original_name || m.file)}<br><span class="meta-line">${esc(m.folder)} · ${Math.round(m.size / 1024)} KB</span></div></a>`).join('') || '<p class="meta">—</p>'}</div>`;
  res.send(K.shell(c, { title: L('مكتبة الوسائط', 'Médiathèque'), active: 'media', body }));
});

router.post('/upload', (req, res, next) => {
  if (!req.can('media.upload')) return res.forbidden();
  upload.array('files', 10)(req, res, async (err) => {
    const json = req.query.json === '1';
    if (err) return json ? res.status(400).json({ error: 'too_large' }) : res.redirect('/admin/media?e=too_large');
    const folder = text(req.body?.folder || 'general').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 40) || 'general';
    const out = []; let failed = '';
    for (const f of req.files || []) {
      try { const m = await M.saveUpload(f, req.user.id, folder); out.push(m); (await audit(req, 'media.upload', 'media', m.id, m.original_name)); }
      catch (e) { failed = e.message === 'too_large' ? 'too_large' : 'unsupported'; }
    }
    if (json) return res.json({ ok: out.length, items: out.map((m) => ({ id: m.id, file: m.file })), error: failed || undefined });
    res.redirect(`/admin/media?${failed && !out.length ? 'e=' + failed : 'm=uploaded'}`);
  });
});

async function mediaFor(req, id) {
  const m = (await db.prepare('SELECT * FROM media WHERE id = ?').get(id));
  if (!m) return null;
  if (!req.can('media.manage') && m.uploaded_by !== req.user.id) return false;
  return m;
}
async function usage(id) {
  return (await db.prepare(`SELECT (SELECT COUNT(*) FROM articles WHERE image_id=@i)+(SELECT COUNT(*) FROM categories WHERE image_id=@i)+(SELECT COUNT(*) FROM advertisements WHERE image_id=@i) n`).get({ i: id })).n
    + (await db.prepare(`SELECT COUNT(*) n FROM article_translations WHERE content LIKE '%' || @f || '%'`).get({ f: (await db.prepare('SELECT file FROM media WHERE id = ?').get(id))?.file || '\u0000' })).n;
}
router.get('/:id', async (req, res, next) => {
  const m = (await mediaFor(req, +req.params.id));
  if (m === null) return next();
  if (m === false) return res.forbidden();
  const c = K.ctxFor(req), { L } = c;
  const body = `<div class="two"><div class="box">${m.kind === 'image' ? `<img src="/uploads/${esc(m.medium || m.file)}" alt="">` : `<video src="/uploads/${esc(m.file)}" controls style="max-width:100%"></video>`}
<p class="meta-line">${esc(m.mime)} · ${Math.round(m.size / 1024)} KB ${m.width ? `· ${m.width}×${m.height}` : ''}<br><code>/uploads/${esc(m.file)}</code></p></div>
<form method="post" class="box f" action="/admin/media/${m.id}">${K.csrfField(c)}
<label>${esc(L('وصف بديل (عربي)', 'Texte alternatif (AR)'))}<input name="alt_ar" dir="rtl" value="${esc(m.alt_ar)}" maxlength="200"></label><label>${esc(L('وصف بديل (فرنسي)', 'Texte alternatif (FR)'))}<input name="alt_fr" value="${esc(m.alt_fr)}" maxlength="200"></label>
<label>${esc(L('تعليق (عربي)', 'Légende (AR)'))}<input name="caption_ar" dir="rtl" value="${esc(m.caption_ar)}" maxlength="300"></label><label>${esc(L('تعليق (فرنسي)', 'Légende (FR)'))}<input name="caption_fr" value="${esc(m.caption_fr)}" maxlength="300"></label>
<label>${esc(L('المجلد', 'Dossier'))}<input name="folder" value="${esc(m.folder)}" maxlength="40"></label><div><button class="btn">${esc(L('حفظ', 'Enregistrer'))}</button></div></form></div>
${req.can('media.manage') ? K.postForm(c, `/admin/media/${m.id}/delete`, `<button class="btn dg sm">${esc(L('حذف الملف', 'Supprimer'))}</button>`, { confirm: L('حذف هذا الملف نهائياً؟', 'Supprimer ce fichier ?') }) : ''}`;
  res.send(K.shell(c, { title: m.original_name || m.file, active: 'media', back: '/admin/media', body }));
});
router.post('/:id', async (req, res, next) => {
  const m = (await mediaFor(req, +req.params.id));
  if (m === null) return next(); if (m === false) return res.forbidden();
  const b = req.body, t = (k, n) => text(b[k]).slice(0, n);
  (await db.prepare('UPDATE media SET alt_ar=?, alt_fr=?, caption_ar=?, caption_fr=?, folder=? WHERE id=?')
    .run(t('alt_ar', 200), t('alt_fr', 200), t('caption_ar', 300), t('caption_fr', 300), t('folder', 40).replace(/[^\p{L}\p{N}_-]/gu, '') || 'general', m.id));
  (await audit(req, 'media.update', 'media', m.id)); res.redirect(`/admin/media/${m.id}?m=saved`);
});
router.post('/:id/delete', async (req, res, next) => {
  if (!req.can('media.manage')) return res.forbidden();
  const m = (await db.prepare('SELECT * FROM media WHERE id = ?').get(+req.params.id));
  if (!m) return next();
  if ((await usage(m.id)) > 0) return res.redirect(`/admin/media/${m.id}?e=in_use`);
  (await db.prepare('DELETE FROM media WHERE id = ?').run(m.id));
  M.deleteMediaFiles(m);
  (await audit(req, 'media.delete', 'media', m.id, m.original_name)); res.redirect('/admin/media?m=deleted');
});
module.exports = router;
