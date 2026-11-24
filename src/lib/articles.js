'use strict';
// Admin-side article service: saving, revisions, editorial workflow. All permission checks happen here (server side).
const db = require('../db');
const { rich, text, videoEmbedUrl } = require('./sanitize');
const { slugify, nowSql, isHttpUrl } = require('./util');
const { notifyUser, notifyPermission } = require('./notify');
const { audit } = require('./audit');

const TYPES = ['news', 'opinion', 'interview', 'investigation', 'video'];
const LANGS = ['ar', 'fr'];

class Denied extends Error { constructor(m = 'forbidden') { super(m); this.status = 403; } }
class Invalid extends Error { constructor(m) { super(m); this.status = 400; } }

const getRow = async (id) => (await db.prepare('SELECT * FROM articles WHERE id = ?').get(id));
const translations = async (id) => Object.fromEntries((await db.prepare('SELECT * FROM article_translations WHERE article_id = ?').all(id)).map((t) => [t.lang, t]));
const titleOf = async (id) => { const t = (await translations(id)); return { ar: t.ar?.title || t.fr?.title || `#${id}`, fr: t.fr?.title || t.ar?.title || `#${id}` }; };
const link = (id) => `/admin/articles/${id}`;

function canEdit(req, a) {
  if (req.can('articles.edit_any')) return true;
  return a.author_id === req.user.id && req.can('articles.edit_own') && ['draft', 'rejected'].includes(a.status);
}
function assertEdit(req, a) { if (!a || !canEdit(req, a)) throw new Denied(); }

async function snapshot(id) {
  const a = (await getRow(id));
  const tags = (await db.prepare('SELECT tag_id FROM article_tags WHERE article_id = ?').all(id)).map((r) => r.tag_id);
  return JSON.stringify({ meta: { type: a.type, category_id: a.category_id, image_id: a.image_id, video_url: a.video_url, author_id: a.author_id, author_label: a.author_label, publish_at: a.publish_at, comments_enabled: a.comments_enabled }, translations: (await translations(id)), tags });
}
async function revision(id, userId, note = '') {
  (await db.prepare('INSERT INTO article_revisions (article_id, user_id, note, snapshot) VALUES (?,?,?,?)').run(id, userId, note, (await snapshot(id))));
  // keep the last 60 revisions
  (await db.prepare('DELETE FROM article_revisions WHERE article_id = ? AND id NOT IN (SELECT id FROM article_revisions WHERE article_id = ? ORDER BY id DESC LIMIT 60)').run(id, id));
}

function cleanTranslation(lang, f) {
  const title = text(f[`title_${lang}`]).slice(0, 250);
  const content = rich(f[`content_${lang}`]).slice(0, 300000);
  const hasBody = content.replace(/<[^>]*>/g, '').trim().length > 0 || /<(img|iframe)\b/i.test(content);
  const summary = text(f[`summary_${lang}`]).slice(0, 600);
  const seo_title = text(f[`seo_title_${lang}`]).slice(0, 120);
  const seo_description = text(f[`seo_description_${lang}`]).slice(0, 300);
  const enabled = f[`enabled_${lang}`] === '0' || f[`enabled_${lang}`] === 'off' ? 0 : 1;
  const used = title || hasBody || summary;
  return used ? { lang, title, slug: slugify(title), summary, content: hasBody ? content : '', seo_title, seo_description, is_enabled: enabled } : null;
}

async function syncTags(articleId, f) {
  const ids = new Set();
  for (const lang of LANGS) {
    const names = String(f[`tags_${lang}`] || '').split(/[,،\n]/).map((s) => text(s).slice(0, 60)).filter(Boolean).slice(0, 15);
    for (const name of names) {
      let row = (await db.prepare('SELECT tag_id FROM tag_translations WHERE lang = ? AND lower(name) = lower(?)').get(lang, name));
      if (!row) {
        let slug = slugify(name, 60), n = 1;
        while ((await db.prepare('SELECT 1 FROM tag_translations WHERE lang = ? AND slug = ?').get(lang, slug))) slug = `${slugify(name, 55)}-${++n}`;
        const tid = (await db.prepare('INSERT INTO tags DEFAULT VALUES').run()).lastInsertRowid;
        (await db.prepare('INSERT INTO tag_translations (tag_id, lang, name, slug) VALUES (?,?,?,?)').run(tid, lang, name, slug));
        row = { tag_id: tid };
      }
      ids.add(row.tag_id);
    }
  }
  (await db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(articleId));
  const ins = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?,?)');
  for (const id of ids) (await ins.run(articleId, id));
}

// Create or update. Returns article id.
async function save(req, id, f) {
  const existing = id ? (await getRow(id)) : null;
  if (id) assertEdit(req, existing); else if (!req.can('articles.create')) throw new Denied();

  const trs = LANGS.map((l) => cleanTranslation(l, f)).filter(Boolean);
  if (!trs.length) throw new Invalid('empty');
  if (trs.some((t) => !t.title)) throw new Invalid('title');
  const cat = parseInt(f.category_id, 10);
  if (!(await db.prepare('SELECT 1 FROM categories WHERE id = ?').get(cat))) throw new Invalid('category');
  const type = TYPES.includes(f.type) ? f.type : 'news';
  const imageId = parseInt(f.image_id, 10) || null;
  if (imageId && !(await db.prepare("SELECT 1 FROM media WHERE id = ? AND kind = 'image'").get(imageId))) throw new Invalid('image');
  let videoUrl = String(f.video_url || '').trim();
  if (videoUrl && !(isHttpUrl(videoUrl) && videoEmbedUrl(videoUrl))) throw new Invalid('video');
  const label = text(f.author_label).slice(0, 120);
  let authorId = existing ? existing.author_id : req.user.id;
  const wanted = parseInt(f.author_id, 10);
  if (wanted && wanted !== authorId && req.can('articles.edit_any')) {
    if ((await db.prepare('SELECT 1 FROM users WHERE id = ? AND is_active = 1').get(wanted))) authorId = wanted;
  }
  const commentsEnabled = f.comments_enabled === '1' ? 1 : 0;
  let publishAt = existing ? existing.publish_at : null;
  if ('publish_at' in f && (req.can('articles.schedule') || req.can('articles.publish'))) {
    publishAt = f.publish_at ? f.publish_at : null;
  }

  const run = db.transaction(async () => {
    let aid = id;
    if (!aid) {
      aid = (await db.prepare(`INSERT INTO articles (author_id, category_id, type, status, image_id, video_url, author_label, comments_enabled, publish_at)
        VALUES (?,?,?,'draft',?,?,?,?,?)`).run(authorId, cat, type, imageId, videoUrl, label, commentsEnabled, publishAt)).lastInsertRowid;
    } else {
      (await db.prepare(`UPDATE articles SET author_id=?, category_id=?, type=?, image_id=?, video_url=?, author_label=?, comments_enabled=?, publish_at=?, updated_at=datetime('now') WHERE id=?`)
        .run(authorId, cat, type, imageId, videoUrl, label, commentsEnabled, publishAt, aid));
    }
    const have = new Set(trs.map((t) => t.lang));
    for (const t of trs) {
      (await db.prepare(`INSERT INTO article_translations (article_id, lang, title, slug, summary, content, seo_title, seo_description, is_enabled)
        VALUES (@a,@lang,@title,@slug,@summary,@content,@seo_title,@seo_description,@is_enabled)
        ON CONFLICT(article_id, lang) DO UPDATE SET title=excluded.title, slug=excluded.slug, summary=excluded.summary, content=excluded.content,
          seo_title=excluded.seo_title, seo_description=excluded.seo_description, is_enabled=excluded.is_enabled`).run({ a: aid, ...t }));
    }
    for (const l of LANGS) if (!have.has(l)) (await db.prepare('DELETE FROM article_translations WHERE article_id = ? AND lang = ?').run(aid, l));
    (await syncTags(aid, f));
    (await revision(aid, req.user.id, existing ? 'edit' : 'create'));
    return aid;
  });
  const aid = (await run());
  (await audit(req, existing ? 'article.update' : 'article.create', 'article', aid, (await titleOf(aid)).ar));
  return aid;
}

async function mustHaveContent(id) {
  const t = (await translations(id));
  if (!Object.values(t).some((x) => x.is_enabled && x.title && x.content)) throw new Invalid('no_content');
}
async function setStatus(id, status, extra = {}) {
  const sets = ['status = @status', "updated_at = datetime('now')"];
  const p = { id, status };
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = @${k}`); p[k] = v; }
  (await db.prepare(`UPDATE articles SET ${sets.join(', ')} WHERE id = @id`).run(p));
}
const futureAt = (a) => a.publish_at && a.publish_at > nowSql();

async function submit(req, id) {
  const a = (await getRow(id));
  if (!a || !req.can('articles.submit') || !(a.author_id === req.user.id || req.can('articles.edit_any'))) throw new Denied();
  if (!['draft', 'rejected'].includes(a.status)) throw new Invalid('state');
  (await mustHaveContent(id));
  (await setStatus(id, 'pending', { review_note: '' }));
  (await revision(id, req.user.id, 'submitted'));
  const t = (await titleOf(id));
  (await notifyPermission('articles.review', 'article_submitted', `مقال جديد بانتظار المراجعة: ${t.ar}`, `Nouvel article à relire : ${t.fr}`, link(id), req.user.id));
  (await audit(req, 'article.submit', 'article', id));
}
async function approve(req, id) {
  const a = (await getRow(id));
  if (!a || !req.can('articles.review')) throw new Denied();
  if (a.status !== 'pending') throw new Invalid('state');
  (await mustHaveContent(id));
  const sched = futureAt(a);
  (await setStatus(id, sched ? 'scheduled' : 'published', { reviewed_by: req.user.id, review_note: '', published_at: sched ? null : nowSql() }));
  (await revision(id, req.user.id, 'approved'));
  const t = (await titleOf(id));
  (await notifyUser(a.author_id, 'article_approved', `تمت الموافقة على مقالك: ${t.ar}`, `Votre article a été approuvé : ${t.fr}`, link(id)));
  if (!sched) (await announcePublished(req, id, a));
  (await audit(req, 'article.approve', 'article', id, sched ? 'scheduled' : 'published'));
}
async function reject(req, id, note) {
  const a = (await getRow(id));
  if (!a || !req.can('articles.review')) throw new Denied();
  if (a.status !== 'pending') throw new Invalid('state');
  (await setStatus(id, 'rejected', { reviewed_by: req.user.id, review_note: text(note).slice(0, 500) }));
  (await revision(id, req.user.id, 'rejected'));
  const t = (await titleOf(id));
  (await notifyUser(a.author_id, 'article_rejected', `تم رفض مقالك: ${t.ar}`, `Votre article a été refusé : ${t.fr}`, link(id)));
  (await audit(req, 'article.reject', 'article', id, note || ''));
}
async function publish(req, id) {
  const a = (await getRow(id));
  if (!a || !req.can('articles.publish')) throw new Denied();
  if (a.status === 'published') return;
  (await mustHaveContent(id));
  (await setStatus(id, 'published', { published_at: a.published_at && a.status === 'archived' ? a.published_at : nowSql(), reviewed_by: req.user.id }));
  (await revision(id, req.user.id, 'published'));
  (await announcePublished(req, id, a));
  (await audit(req, 'article.publish', 'article', id));
}
async function schedule(req, id, when) {
  const a = (await getRow(id));
  if (!a || !req.can('articles.schedule')) throw new Denied();
  if (!when || when <= nowSql()) throw new Invalid('future');
  (await mustHaveContent(id));
  (await setStatus(id, 'scheduled', { publish_at: when, reviewed_by: req.user.id }));
  (await revision(id, req.user.id, 'scheduled'));
  (await audit(req, 'article.schedule', 'article', id, when));
}
async function unpublish(req, id) {
  const a = (await getRow(id));
  if (!a || !req.can('articles.publish')) throw new Denied();
  if (!['published', 'scheduled'].includes(a.status)) throw new Invalid('state');
  (await setStatus(id, 'draft', { featured_slot: null, is_breaking: 0 }));
  (await revision(id, req.user.id, 'unpublished'));
  (await audit(req, 'article.unpublish', 'article', id));
}
async function archive(req, id) {
  const a = (await getRow(id));
  if (!a || !req.can('articles.archive')) throw new Denied();
  if (a.status === 'archived') return;
  (await setStatus(id, 'archived', { archived_from: a.status === 'published' ? 'published' : 'draft', featured_slot: null, is_breaking: 0 }));
  (await audit(req, 'article.archive', 'article', id));
}
async function restore(req, id) {
  const a = (await getRow(id));
  if (!a || !req.can('articles.archive')) throw new Denied();
  if (a.status !== 'archived') throw new Invalid('state');
  (await setStatus(id, a.archived_from === 'published' && a.published_at ? 'published' : 'draft', { archived_from: null }));
  (await audit(req, 'article.restore', 'article', id));
}
async function remove(req, id) {
  const a = (await getRow(id));
  if (!a) throw new Denied();
  const own = a.author_id === req.user.id && a.status === 'draft' && req.can('articles.edit_own');
  if (!req.can('articles.delete') && !own) throw new Denied();
  const t = (await titleOf(id));
  // explicit child deletes: do not depend on ON DELETE CASCADE being enforced by the hosted database
  await db.transaction(async () => {
    for (const tbl of ['article_translations', 'article_revisions', 'article_tags', 'article_views', 'comments']) await db.prepare(`DELETE FROM ${tbl} WHERE article_id = ?`).run(id);
    await db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  })();
  (await audit(req, 'article.delete', 'article', id, t.ar));
}
async function setFeature(req, id, { slot, breaking }) {
  const a = (await getRow(id));
  if (!a || !req.can('articles.feature')) throw new Denied();
  (await db.transaction(async () => {
    if (slot !== undefined) {
      const s = ['main', 'secondary'].includes(slot) ? slot : null;
      if (s === 'main') (await db.prepare("UPDATE articles SET featured_slot = NULL WHERE featured_slot = 'main'").run());
      if (s === 'secondary') {
        const olds = (await db.prepare("SELECT id FROM articles WHERE featured_slot = 'secondary' AND id <> ? ORDER BY updated_at DESC").all(id));
        for (const o of olds.slice(1)) (await db.prepare('UPDATE articles SET featured_slot = NULL WHERE id = ?').run(o.id)); // keep max 2 secondary
      }
      (await db.prepare('UPDATE articles SET featured_slot = ? WHERE id = ?').run(s, id));
    }
    if (breaking !== undefined) (await db.prepare('UPDATE articles SET is_breaking = ? WHERE id = ?').run(breaking ? 1 : 0, id));
  })());
  (await audit(req, 'article.feature', 'article', id, JSON.stringify({ slot, breaking })));
}
async function restoreRevision(req, id, revId) {
  const a = (await getRow(id));
  assertEdit(req, a);
  const r = (await db.prepare('SELECT * FROM article_revisions WHERE id = ? AND article_id = ?').get(revId, id));
  if (!r) throw new Invalid('revision');
  const s = JSON.parse(r.snapshot);
  (await db.transaction(async () => {
    (await revision(id, req.user.id, 'before-restore'));
    const m = s.meta;
    (await db.prepare(`UPDATE articles SET category_id=?, type=?, image_id=?, video_url=?, author_label=?, comments_enabled=?, updated_at=datetime('now') WHERE id=?`)
      .run(m.category_id, m.type, m.image_id, m.video_url, m.author_label, m.comments_enabled, id));
    (await db.prepare('DELETE FROM article_translations WHERE article_id = ?').run(id));
    for (const t of Object.values(s.translations)) {
      (await db.prepare(`INSERT INTO article_translations (article_id, lang, title, slug, summary, content, seo_title, seo_description, is_enabled) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, t.lang, t.title, t.slug, t.summary, rich(t.content), t.seo_title, t.seo_description, t.is_enabled));
    }
    (await revision(id, req.user.id, `restored #${revId}`));
  })());
  (await audit(req, 'article.revision_restore', 'article', id, `rev ${revId}`));
}

async function announcePublished(req, id, a) {
  const t = (await titleOf(id));
  if (a.author_id && a.author_id !== req.user?.id) (await notifyUser(a.author_id, 'article_published', `تم نشر مقالك: ${t.ar}`, `Votre article est publié : ${t.fr}`, link(id)));
  (await notifyPermission('analytics.view', 'article_published', `تم نشر: ${t.ar}`, `Publié : ${t.fr}`, link(id), req.user?.id));
}

// Called by the scheduler: publish due scheduled articles
async function publishDue() {
  const due = (await db.prepare(`SELECT * FROM articles WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= datetime('now')`).all());
  for (const a of due) {
    (await db.prepare(`UPDATE articles SET status = 'published', published_at = publish_at, updated_at = datetime('now') WHERE id = ?`).run(a.id));
    const t = (await titleOf(a.id));
    (await notifyUser(a.author_id, 'article_published', `تم نشر مقالك المجدول: ${t.ar}`, `Votre article programmé est publié : ${t.fr}`, link(a.id)));
    (await notifyPermission('analytics.view', 'article_published', `نُشر (مجدول): ${t.ar}`, `Publié (programmé) : ${t.fr}`, link(a.id), a.author_id));
  }
  return due.length;
}

module.exports = { save, submit, approve, reject, publish, schedule, unpublish, archive, restore, remove, setFeature, restoreRevision, publishDue, canEdit, getRow, translations, titleOf, Denied, Invalid, TYPES, LANGS };
