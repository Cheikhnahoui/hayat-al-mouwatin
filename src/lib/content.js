'use strict';
// Public-facing queries (published content only)
const db = require('../db');
const settings = require('./settings');
const { stripTags } = require('./sanitize');

const PUBLISHED = `a.status = 'published' AND a.published_at <= datetime('now')`;

const BASE = `
  SELECT a.id, a.type, a.featured_slot, a.is_breaking, a.video_url, a.view_count, a.published_at, a.updated_at, a.author_label, a.comments_enabled, a.category_id,
         t.title, t.slug, t.summary, t.seo_title, t.seo_description,
         c.key AS cat_key, c.hue AS cat_hue, ct.name AS cat_name, ct.slug AS cat_slug,
         u.id AS author_id, u.name_ar AS au_ar, u.name_fr AS au_fr,
         m.file AS img_file, m.thumb AS img_thumb, m.medium AS img_medium, m.width AS img_w, m.height AS img_h, m.alt_ar, m.alt_fr, m.caption_ar, m.caption_fr
  FROM articles a
  JOIN article_translations t ON t.article_id = a.id AND t.lang = @lang AND t.is_enabled = 1 AND t.title <> '' AND t.content <> ''
  JOIN categories c ON c.id = a.category_id AND c.is_active = 1
  JOIN category_translations ct ON ct.category_id = c.id AND ct.lang = @lang
  LEFT JOIN users u ON u.id = a.author_id
  LEFT JOIN media m ON m.id = a.image_id`;

function decorate(r, lang) {
  if (!r) return r;
  r.lang = lang;
  r.author = r.author_label || (lang === 'ar' ? r.au_ar || r.au_fr : r.au_fr || r.au_ar) || '';
  r.img_alt = (lang === 'ar' ? r.alt_ar : r.alt_fr) || r.title;
  return r;
}

function list(lang, { where = '', params = {}, order = 'a.published_at DESC', limit = 10, offset = 0 } = {}) {
  const sql = `${BASE} WHERE ${PUBLISHED} ${where ? 'AND ' + where : ''} ORDER BY ${order} LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all({ lang, limit, offset, ...params }).map((r) => decorate(r, lang));
}
function count(lang, { where = '', params = {} } = {}) {
  const sql = `SELECT COUNT(*) n FROM articles a
    JOIN article_translations t ON t.article_id = a.id AND t.lang = @lang AND t.is_enabled = 1 AND t.title <> '' AND t.content <> ''
    JOIN categories c ON c.id = a.category_id AND c.is_active = 1
    JOIN category_translations ct ON ct.category_id = c.id AND ct.lang = @lang
    LEFT JOIN users u ON u.id = a.author_id
    WHERE ${PUBLISHED} ${where ? 'AND ' + where : ''}`;
  return db.prepare(sql).get({ lang, ...params }).n;
}

function categories(lang, { onlyActive = true } = {}) {
  return db.prepare(`
    SELECT c.id, c.key, c.hue, c.sort_order, c.show_on_home, c.image_id, ct.name, ct.slug, ct.description, ct.seo_title, ct.seo_description,
           (SELECT file FROM media WHERE id = c.image_id) AS img_file
    FROM categories c JOIN category_translations ct ON ct.category_id = c.id AND ct.lang = ?
    ${onlyActive ? 'WHERE c.is_active = 1' : ''} ORDER BY c.sort_order, c.id`).all(lang);
}
function categoryBySlug(lang, slug) {
  return db.prepare(`
    SELECT c.id, c.key, c.hue, c.image_id, ct.name, ct.slug, ct.description, ct.seo_title, ct.seo_description
    FROM categories c JOIN category_translations ct ON ct.category_id = c.id AND ct.lang = ?
    WHERE c.is_active = 1 AND ct.slug = ?`).get(lang, slug);
}
const categorySlugs = (id) => Object.fromEntries(db.prepare('SELECT lang, slug FROM category_translations WHERE category_id = ?').all(id).map((r) => [r.lang, r.slug]));

function getArticle(id, lang) {
  const r = db.prepare(`${BASE.replace('SELECT a.id,', 'SELECT t.content, a.id,')} WHERE a.id = @id AND ${PUBLISHED}`).get({ id, lang });
  return decorate(r, lang);
}
// which languages is this published article available in?
function availableLangs(id) {
  return db.prepare(`
    SELECT t.lang, t.slug FROM article_translations t JOIN articles a ON a.id = t.article_id
    WHERE t.article_id = ? AND t.is_enabled = 1 AND t.title <> '' AND t.content <> '' AND ${PUBLISHED}`).all(id)
    .reduce((o, r) => ((o[r.lang] = r.slug), o), {});
}
function articleExists(id) {
  return db.prepare(`SELECT 1 FROM articles a WHERE a.id = ? AND ${PUBLISHED}`).get(id);
}
function tagsFor(articleId, lang) {
  return db.prepare(`SELECT tt.name, tt.slug FROM article_tags at JOIN tag_translations tt ON tt.tag_id = at.tag_id AND tt.lang = ?
    WHERE at.article_id = ? ORDER BY tt.name`).all(lang, articleId);
}
function tagBySlug(lang, slug) { return db.prepare('SELECT tag_id, name, slug FROM tag_translations WHERE lang = ? AND slug = ?').get(lang, slug); }

function related(lang, art, n = 4) {
  const tagIds = db.prepare('SELECT tag_id FROM article_tags WHERE article_id = ?').all(art.id).map((r) => r.tag_id);
  const byTag = tagIds.length
    ? list(lang, { where: `a.id <> @id AND a.id IN (SELECT article_id FROM article_tags WHERE tag_id IN (${tagIds.join(',')}))`, params: { id: art.id }, limit: n })
    : [];
  if (byTag.length >= n) return byTag;
  const have = [art.id, ...byTag.map((x) => x.id)];
  const more = list(lang, { where: `a.category_id = @cat AND a.id NOT IN (${have.join(',')})`, params: { cat: art.category_id }, limit: n - byTag.length });
  return [...byTag, ...more];
}

function mostRead(lang, limit = 5, days = 30) {
  return list(lang, { where: `a.published_at >= datetime('now', @since)`, params: { since: `-${days} days` }, order: 'a.view_count DESC, a.published_at DESC', limit });
}
function trending(lang, limit = 5) {
  return list(lang, {
    where: `a.id IN (SELECT article_id FROM article_views WHERE day >= date('now','-2 days'))`,
    order: `(SELECT COALESCE(SUM(views),0) FROM article_views v WHERE v.article_id = a.id AND v.day >= date('now','-2 days')) DESC, a.published_at DESC`,
    limit,
  });
}
function breaking(lang) {
  if (!settings.bool('breaking_enabled')) return [];
  const n = Math.min(Math.max(parseInt(settings.get('breaking_count'), 10) || 5, 1), 15);
  const flagged = settings.get('breaking_mode') === 'flagged';
  return list(lang, { where: flagged ? 'a.is_breaking = 1' : '1=1', limit: n });
}

// Search: title, summary, content, category name, author name; filters: category, date range, author
function likeEsc(s) { return '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%'; }
function search(lang, { q = '', category = 0, from = '', to = '', author = 0, tag = 0, page = 1, per = 12 }) {
  const w = [], p = {};
  if (q) {
    w.push(`(t.title LIKE @q ESCAPE '\\' OR t.summary LIKE @q ESCAPE '\\' OR t.content LIKE @q ESCAPE '\\' OR ct.name LIKE @q ESCAPE '\\'
      OR u.name_ar LIKE @q ESCAPE '\\' OR u.name_fr LIKE @q ESCAPE '\\' OR a.author_label LIKE @q ESCAPE '\\')`);
    p.q = likeEsc(q);
  }
  if (category) { w.push('a.category_id = @cat'); p.cat = category; }
  if (author) { w.push('a.author_id = @au'); p.au = author; }
  if (tag) { w.push('a.id IN (SELECT article_id FROM article_tags WHERE tag_id = @tag)'); p.tag = tag; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { w.push(`date(a.published_at) >= @from`); p.from = from; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { w.push(`date(a.published_at) <= @to`); p.to = to; }
  const where = w.join(' AND ');
  const total = count(lang, { where, params: p });
  const items = list(lang, { where, params: p, limit: per, offset: (Math.max(page, 1) - 1) * per });
  return { items, total, pages: Math.max(1, Math.ceil(total / per)) };
}

const readingMinutes = (html) => Math.max(1, Math.round(stripTags(html).split(/\s+/).length / 200));

// view counter (deduplicated in memory per visitor+article for 30 min)
const seen = new Map();
function countView(articleId, visitorKey) {
  const k = visitorKey + ':' + articleId, now = Date.now();
  if (seen.size > 20000) for (const [kk, t] of seen) if (now - t > 1800e3) seen.delete(kk);
  if (seen.has(k) && now - seen.get(k) < 1800e3) return;
  seen.set(k, now);
  db.transaction(() => {
    db.prepare('UPDATE articles SET view_count = view_count + 1 WHERE id = ?').run(articleId);
    db.prepare(`INSERT INTO article_views (article_id, day, views) VALUES (?, date('now'), 1) ON CONFLICT(article_id, day) DO UPDATE SET views = views + 1`).run(articleId);
  })();
}

function author(id) { return db.prepare('SELECT id, name_ar, name_fr, bio_ar, bio_fr, avatar FROM users WHERE id = ? AND is_active = 1').get(id); }

module.exports = { list, count, categories, categoryBySlug, categorySlugs, getArticle, availableLangs, articleExists, tagsFor, tagBySlug, related, mostRead, trending, breaking, search, readingMinutes, countView, author, PUBLISHED };
