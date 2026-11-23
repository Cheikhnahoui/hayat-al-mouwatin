'use strict';
const db = require('../db');
const settings = require('./settings');
const { today } = require('./util');
const { notifyPermission } = require('./notify');

const PLACEMENTS = {
  home_top: { ar: 'الرئيسية – شريط علوي', fr: 'Accueil – bannière haute', size: '970×120' },
  home_sidebar: { ar: 'الرئيسية – الشريط الجانبي', fr: 'Accueil – colonne latérale', size: '300×250' },
  home_between: { ar: 'الرئيسية – بين الأقسام', fr: 'Accueil – entre les sections', size: '970×120' },
  article_inline: { ar: 'داخل صفحة المقال', fr: 'Dans la page article', size: '728×120' },
  article_below: { ar: 'أسفل المقال', fr: 'Sous l’article', size: '728×120' },
  footer: { ar: 'التذييل', fr: 'Pied de page', size: '970×90' },
};

const ACTIVE = `a.is_active = 1 AND (a.start_at IS NULL OR a.start_at <= datetime('now')) AND (a.end_at IS NULL OR a.end_at >= datetime('now'))`;

function pick(placement, { count = true, isBot = false } = {}) {
  if (!settings.bool('ads_enabled')) return null;
  const ad = db.prepare(`SELECT a.*, m.file, m.medium FROM advertisements a LEFT JOIN media m ON m.id = a.image_id
    WHERE a.placement = ? AND ${ACTIVE} AND a.image_id IS NOT NULL ORDER BY RANDOM() LIMIT 1`).get(placement);
  if (ad && count && !isBot) {
    db.prepare(`INSERT INTO advertisement_statistics (ad_id, day, impressions) VALUES (?, ?, 1)
      ON CONFLICT(ad_id, day) DO UPDATE SET impressions = impressions + 1`).run(ad.id, today());
  }
  return ad;
}
function click(id) {
  const ad = db.prepare(`SELECT a.* FROM advertisements a WHERE a.id = ?`).get(id);
  if (!ad) return null;
  db.prepare(`INSERT INTO advertisement_statistics (ad_id, day, clicks) VALUES (?, ?, 1)
    ON CONFLICT(ad_id, day) DO UPDATE SET clicks = clicks + 1`).run(id, today());
  return ad.destination_url;
}
function totals(id) {
  return db.prepare('SELECT COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks FROM advertisement_statistics WHERE ad_id = ?').get(id);
}
// notify ad managers when a campaign ends within 2 days (once per campaign)
function checkEnding() {
  const rows = db.prepare(`SELECT id, title FROM advertisements WHERE is_active = 1 AND expiry_notified = 0 AND end_at IS NOT NULL AND end_at <= datetime('now','+2 days')`).all();
  for (const r of rows) {
    notifyPermission('ads.manage', 'ad_ending', `الحملة الإعلانية على وشك الانتهاء: ${r.title}`, `Campagne bientôt terminée : ${r.title}`, `/admin/ads/${r.id}`);
    db.prepare('UPDATE advertisements SET expiry_notified = 1 WHERE id = ?').run(r.id);
  }
}
module.exports = { PLACEMENTS, pick, click, totals, checkEnding };
