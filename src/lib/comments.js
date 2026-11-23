'use strict';
const db = require('../db');
const settings = require('./settings');
const { text } = require('./sanitize');
const { hmac } = require('./util');
const { notifyPermission } = require('./notify');

const SPAM_PATTERNS = [/\b(viagra|casino|loan|crypto|porn|xxx|bitcoin|forex)\b/i];

// returns {ok, status?, error?}
function submit({ articleId, name, email, body, honeypot, formAge, ip }) {
  if (!settings.bool('comments_enabled')) return { error: 'closed' };
  const art = db.prepare("SELECT id, comments_enabled FROM articles WHERE id = ? AND status = 'published'").get(articleId);
  if (!art || !art.comments_enabled) return { error: 'closed' };
  if (honeypot) return { ok: true, status: 'spam', silent: true };          // bots: pretend success
  if (formAge < 3) return { error: 'invalid' };                              // submitted too fast
  name = text(name).slice(0, 60); email = text(email).slice(0, 120); body = text(body).slice(0, 2000);
  if (name.length < 2 || body.length < 3) return { error: 'invalid' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'invalid' };

  const ipHash = hmac('ip:' + ip);
  const recent = db.prepare(`SELECT COUNT(*) n FROM comment_throttle WHERE ip_hash = ? AND created_at > datetime('now','-10 minutes')`).get(ipHash).n;
  if (recent >= 3) return { error: 'rate' };
  db.prepare('INSERT INTO comment_throttle (ip_hash) VALUES (?)').run(ipHash);

  const links = (body.match(/https?:\/\/|www\./gi) || []).length;
  const banned = settings.get('comments_banned_words').split(/[,\n،]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const lower = body.toLowerCase();
  let status = settings.get('comments_mode') === 'open' ? 'approved' : 'pending';
  if (links > (parseInt(settings.get('comments_max_links'), 10) || 0) || SPAM_PATTERNS.some((r) => r.test(body)) || banned.some((w) => lower.includes(w))) status = 'spam';
  // duplicate content
  if (db.prepare('SELECT 1 FROM comments WHERE article_id = ? AND body = ? AND ip_hash = ?').get(articleId, body, ipHash)) status = 'spam';

  db.prepare('INSERT INTO comments (article_id, author_name, author_email, body, status, ip_hash) VALUES (?,?,?,?,?,?)').run(articleId, name, email, body, status, ipHash);
  if (status === 'pending') notifyPermission('comments.moderate', 'comment_pending', 'تعليق جديد بانتظار المراجعة', 'Nouveau commentaire à modérer', '/admin/comments?status=pending');
  return { ok: true, status };
}
function forArticle(articleId) {
  return db.prepare(`SELECT id, author_name, body, created_at FROM comments WHERE article_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 100`).all(articleId);
}
function report(id) {
  const c = db.prepare('SELECT id, reports, status FROM comments WHERE id = ?').get(id);
  if (!c) return false;
  db.prepare('UPDATE comments SET reports = reports + 1 WHERE id = ?').run(id);
  // 3+ reports: pull back to moderation queue
  if (c.reports + 1 >= 3 && c.status === 'approved') {
    db.prepare("UPDATE comments SET status = 'pending' WHERE id = ?").run(id);
    notifyPermission('comments.moderate', 'comment_reported', 'تعليق تم الإبلاغ عنه عدة مرات', 'Commentaire signalé plusieurs fois', '/admin/comments?status=pending');
  }
  return true;
}
module.exports = { submit, forArticle, report };
