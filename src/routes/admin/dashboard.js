'use strict';
const express = require('express');
const db = require('../../db');
const K = require('../../views/admin/kit');
const { esc, num } = require('../../lib/util');
const router = express.Router();

const q1 = (sql, ...p) => db.prepare(sql).get(...p);

router.get('/', (req, res) => {
  const c = K.ctxFor(req), { L, lang } = c;
  const by = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM articles GROUP BY status').all().map((r) => [r.status, r.n]));
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const mine = !req.can('articles.edit_any') && !req.can('articles.review');
  const views = q1('SELECT COALESCE(SUM(view_count),0) n FROM articles').n;
  const journalists = q1("SELECT COUNT(DISTINCT u.id) n FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE r.key='journalist' AND u.is_active=1").n;
  const admins = q1("SELECT COUNT(DISTINCT u.id) n FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE r.key IN ('admin','super_admin') AND u.is_active=1").n;
  const cats = q1('SELECT COUNT(*) n FROM categories').n;
  const card = (n, lbl, href) => `<a class="box" ${href ? `href="${href}"` : ''} style="display:block"><b>${num(n, lang)}</b><span>${esc(lbl)}</span></a>`;

  let stats = '';
  if (mine) {
    const m = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM articles WHERE author_id = ? GROUP BY status').all(req.user.id).map((r) => [r.status, r.n]));
    const mv = q1('SELECT COALESCE(SUM(view_count),0) n FROM articles WHERE author_id = ?', req.user.id).n;
    stats = `<div class="cards">${card(m.draft || 0, L('مسوداتي', 'Mes brouillons'), '/admin/articles?status=draft')}${card(m.pending || 0, L('قيد المراجعة', 'En relecture'), '/admin/articles?status=pending')}${card(m.rejected || 0, L('مرفوضة', 'Refusés'), '/admin/articles?status=rejected')}${card(m.published || 0, L('منشورة', 'Publiés'), '/admin/articles?status=published')}${card(mv, L('مشاهدات مقالاتي', 'Vues de mes articles'))}</div>`;
  } else {
    stats = `<div class="cards">${card(total, L('إجمالي المقالات', 'Total articles'), '/admin/articles')}${card(by.published || 0, L('منشورة', 'Publiés'), '/admin/articles?status=published')}${card(by.draft || 0, L('مسودات', 'Brouillons'), '/admin/articles?status=draft')}${card(by.pending || 0, L('بانتظار المراجعة', 'En attente'), '/admin/articles?status=pending')}${card(by.scheduled || 0, L('مجدولة', 'Programmés'), '/admin/articles?status=scheduled')}${card(views, L('إجمالي المشاهدات', 'Vues totales'))}${card(journalists, L('الصحفيون', 'Journalistes'), req.can('users.view') ? '/admin/users' : '')}${card(admins, L('المديرون النشطون', 'Admins actifs'))}${card(cats, L('التصنيفات', 'Catégories'), req.can('categories.manage') ? '/admin/categories' : '')}</div>`;
  }

  let traffic = '';
  if (req.can('analytics.view')) {
    const rows = db.prepare(`WITH RECURSIVE d(day) AS (SELECT date('now','-13 days') UNION ALL SELECT date(day,'+1 day') FROM d WHERE day < date('now'))
      SELECT d.day, COALESCE((SELECT SUM(views) FROM article_views v WHERE v.day = d.day),0) AS views FROM d`).all();
    const max = Math.max(1, ...rows.map((r) => r.views));
    traffic = `<div class="box"><h2>${esc(L('الزيارات (آخر 14 يوماً)', 'Trafic (14 derniers jours)'))}</h2><div class="bars">${rows.map((r) => `<div style="height:${Math.round((r.views / max) * 100)}%" title="${r.day}: ${r.views}"><span>${r.views || ''}</span></div>`).join('')}</div><div class="bars-l">${rows.map((r) => `<span>${r.day.slice(8)}</span>`).join('')}</div></div>`;
  }
  let recent = '';
  if (req.can('audit.view') || req.can('analytics.view')) {
    const rows = db.prepare(`SELECT l.*, u.username FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 10`).all();
    recent = `<div class="box"><h2>${esc(L('آخر النشاطات', 'Activités récentes'))}</h2>${rows.map((r) => `<div class="meta-line" style="padding:4px 0;border-bottom:1px solid var(--bd)"><b>${esc(r.username || '—')}</b> · ${esc(r.action)} ${esc(r.entity)} ${esc(r.entity_id)}<br>${K.dt(c, r.created_at)}</div>`).join('') || '—'}</div>`;
  }
  const pend = req.can('articles.review')
    ? db.prepare(`SELECT a.id, t.title, a.updated_at FROM articles a JOIN article_translations t ON t.article_id=a.id AND t.lang=(SELECT lang FROM article_translations WHERE article_id=a.id ORDER BY lang LIMIT 1) WHERE a.status='pending' ORDER BY a.updated_at LIMIT 6`).all() : [];
  const queue = pend.length ? `<div class="box"><h2>${esc(L('بانتظار مراجعتك', 'À relire'))}</h2>${pend.map((p) => `<div style="padding:4px 0"><a href="/admin/articles/${p.id}">${esc(p.title)}</a></div>`).join('')}</div>` : '';
  const quick = req.can('articles.create') ? `<p><a class="btn" href="/admin/articles/new">+ ${esc(L('مقال جديد', 'Nouvel article'))}</a></p>` : '';
  res.send(K.shell(c, { title: L('لوحة المعلومات', 'Tableau de bord'), active: 'dashboard', body: `${quick}${stats}<div class="two"><div class="sidebar-stack">${traffic}${queue}</div>${recent}</div>` }));
});
module.exports = router;
