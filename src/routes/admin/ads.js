'use strict';
const express = require('express');
const db = require('../../db');
const ads = require('../../lib/ads');
const K = require('../../views/admin/kit');
const { esc, toInput, fromInput, isHttpUrl, num, today } = require('../../lib/util');
const { text } = require('../../lib/sanitize');
const { audit } = require('../../lib/audit');
const router = express.Router();

router.use((req, res, next) => (req.can('ads.manage') || req.can('ads.stats') ? next() : res.forbidden()));
const manage = (req, res, next) => (req.can('ads.manage') ? next() : res.forbidden());

const picker = async (c, id) => {
  const m = id ? (await db.prepare('SELECT * FROM media WHERE id = ?').get(id)) : null;
  return `<div class="pick" data-pick="image"><input type="hidden" name="image_id" value="${esc(id || '')}"><img src="${m ? '/uploads/' + esc(m.thumb || m.file) : ''}" alt="" style="${m ? '' : 'display:none'};width:160px;height:auto"><button type="button" class="btn gh sm" data-open>${esc(c.L('اختيار / رفع الصورة', 'Choisir / téléverser'))}</button></div>
<div id="mediaModal" class="modal"><div class="in"><div class="bar"><input id="mediaSearch" placeholder="${esc(c.L('بحث…', 'Rechercher…'))}"><label class="btn gh sm" style="cursor:pointer">${esc(c.L('رفع صورة', 'Téléverser'))}<input id="mediaUpload" type="file" accept="image/*" multiple hidden></label><span style="flex:1"></span><button type="button" class="btn gh sm" data-mclose>✕</button></div><div id="mediaGrid" class="mgrid"></div></div></div>`;
};
const state = (a) => {
  const n = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (!a.is_active) return 'off'; if (a.start_at && a.start_at > n) return 'soon'; if (a.end_at && a.end_at < n) return 'ended'; return 'live';
};
const STL = { off: ['متوقف', 'Inactive'], soon: ['قادم', 'À venir'], ended: ['منتهٍ', 'Terminée'], live: ['جارٍ', 'En cours'] };

router.get('/', async (req, res) => {
  const c = K.ctxFor(req), { L, lang } = c;
  const rows = (await db.prepare(`SELECT a.*, COALESCE((SELECT SUM(impressions) FROM advertisement_statistics WHERE ad_id=a.id),0) imp, COALESCE((SELECT SUM(clicks) FROM advertisement_statistics WHERE ad_id=a.id),0) clk FROM advertisements a ORDER BY a.id DESC`).all());
  const ctr = (r) => (r.imp ? ((r.clk / r.imp) * 100).toFixed(2) + '%' : '—');
  const body = `${req.can('ads.manage') ? `<p><a class="btn" href="/admin/ads/new">+ ${esc(L('إعلان جديد', 'Nouvelle publicité'))}</a></p>` : ''}
<div class="box">${K.table([L('العنوان', 'Titre'), L('الموضع', 'Emplacement'), L('الفترة', 'Période'), L('الحالة', 'État'), L('ظهور', 'Impr.'), L('نقرات', 'Clics'), 'CTR', ''],
    rows.map((r) => { const s = state(r); return `<tr><td>${esc(r.title)}</td><td>${esc(ads.PLACEMENTS[r.placement]?.[lang])}</td><td>${r.start_at ? esc(r.start_at.slice(0, 10)) : '…'} → ${r.end_at ? esc(r.end_at.slice(0, 10)) : '…'}</td><td><span class="badge ${s === 'live' ? 'st-published' : s === 'ended' ? 'st-rejected' : 'st-draft'}">${esc(L(...STL[s]))}</span></td><td>${num(r.imp, lang)}</td><td>${num(r.clk, lang)}</td><td>${ctr(r)}</td><td><a class="btn gh sm" href="/admin/ads/${r.id}">${esc(L(req.can('ads.manage') ? 'تعديل' : 'عرض', req.can('ads.manage') ? 'Modifier' : 'Voir'))}</a></td></tr>`; }))}</div>`;
  res.send(K.shell(c, { title: L('الإعلانات', 'Publicités'), active: 'ads', body }));
});

async function form(req, res, ad, vals, err) {
  const c = K.ctxFor(req), { L, lang } = c;
  const v = (k, d = '') => (vals && k in vals ? vals[k] : d);
  let stats = '';
  if (ad) {
    const days = (await db.prepare('SELECT * FROM advertisement_statistics WHERE ad_id = ? ORDER BY day DESC LIMIT 30').all(ad.id));
    const t = (await ads.totals(ad.id));
    stats = `<div class="box"><h3>${esc(L('الإحصاءات', 'Statistiques'))}</h3><p><b>${num(t.impressions, lang)}</b> ${esc(L('ظهور', 'impressions'))} · <b>${num(t.clicks, lang)}</b> ${esc(L('نقرة', 'clics'))}</p>${K.table([L('اليوم', 'Jour'), L('ظهور', 'Impr.'), L('نقرات', 'Clics')], days.map((d) => `<tr><td>${d.day}</td><td>${d.impressions}</td><td>${d.clicks}</td></tr>`))}</div>`;
  }
  const dis = req.can('ads.manage') ? '' : 'disabled';
  const body = `${err ? `<div class="flash err">${esc(L(...(K.ERR[err] || K.ERR.invalid)))}</div>` : ''}<div class="two"><form method="post" class="box f" action="${ad ? `/admin/ads/${ad.id}` : '/admin/ads'}">${K.csrfField(c)}
<label>${esc(L('العنوان', 'Titre'))}<input name="title" required maxlength="120" value="${esc(v('title', ad?.title || ''))}" ${dis}></label>
<label>${esc(L('الموضع', 'Emplacement'))}<select name="placement" ${dis}>${Object.entries(ads.PLACEMENTS).map(([k, p]) => `<option value="${k}" ${v('placement', ad?.placement) === k ? 'selected' : ''}>${esc(p[lang])} (${p.size})</option>`).join('')}</select></label>
<label>${esc(L('الرابط الوجهة', 'URL de destination'))}<input name="destination_url" type="url" required value="${esc(v('destination_url', ad?.destination_url || ''))}" placeholder="https://" ${dis}></label>
<div class="row2"><label>${esc(L('البداية (UTC)', 'Début (UTC)'))}<input type="datetime-local" name="start_at" value="${esc(v('start_at', toInput(ad?.start_at)))}" ${dis}></label><label>${esc(L('النهاية (UTC)', 'Fin (UTC)'))}<input type="datetime-local" name="end_at" value="${esc(v('end_at', toInput(ad?.end_at)))}" ${dis}></label></div>
<label class="chk"><input type="checkbox" name="is_active" value="1" ${(vals ? vals.is_active : ad ? ad.is_active : 1) ? 'checked' : ''} ${dis}> ${esc(L('مفعّل', 'Active'))}</label>
${req.can('ads.manage') ? (await picker(c, v('image_id', ad?.image_id))) : ''}${req.can('ads.manage') ? `<div><button class="btn">${esc(L('حفظ', 'Enregistrer'))}</button></div>` : ''}</form>${stats}</div>
${ad && req.can('ads.manage') ? K.postForm(c, `/admin/ads/${ad.id}/delete`, `<button class="btn dg sm">${esc(L('حذف', 'Supprimer'))}</button>`, { confirm: L('حذف الإعلان؟', 'Supprimer cette publicité ?') }) : ''}`;
  res.send(K.shell(c, { title: ad ? ad.title : L('إعلان جديد', 'Nouvelle publicité'), active: 'ads', back: '/admin/ads', body }));
}
router.get('/new', manage, async (req, res) => (await form(req, res, null)));
async function parse(b) {
  const title = text(b.title).slice(0, 120);
  const url = String(b.destination_url || '').trim();
  const imageId = parseInt(b.image_id, 10) || null;
  if (!title || !isHttpUrl(url) || !ads.PLACEMENTS[b.placement]) return { err: 'invalid' };
  if (imageId && !(await db.prepare("SELECT 1 FROM media WHERE id = ? AND kind = 'image'").get(imageId))) return { err: 'image' };
  if (!imageId) return { err: 'image' };
  const s = fromInput(b.start_at), e = fromInput(b.end_at);
  if (s && e && e <= s) return { err: 'future' };
  return { v: { title, url, imageId, s, e, placement: b.placement, active: b.is_active ? 1 : 0 } };
}
router.post('/', manage, async (req, res) => {
  const p = (await parse(req.body));
  if (p.err) return (await form(req, res, null, req.body, p.err));
  const v = p.v;
  const id = (await db.prepare('INSERT INTO advertisements (title, placement, image_id, destination_url, start_at, end_at, is_active, created_by) VALUES (?,?,?,?,?,?,?,?)').run(v.title, v.placement, v.imageId, v.url, v.s, v.e, v.active, req.user.id)).lastInsertRowid;
  (await audit(req, 'ad.create', 'ad', id, v.title)); res.redirect(`/admin/ads/${id}?m=saved`);
});
router.get('/:id', async (req, res, next) => { const ad = (await db.prepare('SELECT * FROM advertisements WHERE id = ?').get(+req.params.id)); if (!ad) return next(); (await form(req, res, ad)); });
router.post('/:id', manage, async (req, res, next) => {
  const ad = (await db.prepare('SELECT * FROM advertisements WHERE id = ?').get(+req.params.id)); if (!ad) return next();
  const p = (await parse(req.body));
  if (p.err) return (await form(req, res, ad, req.body, p.err));
  const v = p.v;
  (await db.prepare(`UPDATE advertisements SET title=?, placement=?, image_id=?, destination_url=?, start_at=?, end_at=?, is_active=?, expiry_notified=CASE WHEN ? IS NOT ? THEN 0 ELSE expiry_notified END, updated_at=datetime('now') WHERE id=?`)
    .run(v.title, v.placement, v.imageId, v.url, v.s, v.e, v.active, v.e, ad.end_at, ad.id));
  (await audit(req, 'ad.update', 'ad', ad.id)); res.redirect(`/admin/ads/${ad.id}?m=saved`);
});
router.post('/:id/delete', manage, async (req, res) => {
  await db.prepare('DELETE FROM advertisement_statistics WHERE ad_id = ?').run(+req.params.id);
  (await db.prepare('DELETE FROM advertisements WHERE id = ?').run(+req.params.id));
  (await audit(req, 'ad.delete', 'ad', req.params.id)); res.redirect('/admin/ads?m=deleted');
});
module.exports = router;
