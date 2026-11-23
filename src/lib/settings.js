'use strict';
const db = require('../db');

const DEFAULTS = {
  site_name_ar: 'حياة المواطن',
  site_name_fr: 'Hayat Al Mouwatin',
  description_ar: 'منصة إخبارية موريتانية مستقلة تنقل لكم نبض الوطن والعالم بمهنية ومصداقية.',
  description_fr: 'Média mauritanien indépendant : l’actualité du pays et du monde, avec rigueur et crédibilité.',
  logo: '/img/logo.png',
  favicon: '/img/logo.png',
  color_primary: '#8b1220',
  color_primary_dark: '#6a0d18',
  contact_email: '',
  phone: '',
  social_facebook: '', social_x: '', social_youtube: '', social_instagram: '', social_whatsapp: '',
  default_lang: 'ar',
  available_langs: 'ar,fr',
  home_sections: 'hero,latest,popular,trending,categories,interviews,investigations,opinions,videos',
  seo_keywords_ar: '', seo_keywords_fr: '',
  seo_default_image: '/img/logo.png',
  ads_enabled: '1',
  comments_enabled: '1',
  comments_mode: 'moderated',   // moderated | open
  comments_max_links: '1',
  comments_banned_words: '',
  breaking_enabled: '1',
  breaking_count: '5',
  breaking_mode: 'flagged',     // flagged = only breaking-flagged articles, latest = newest articles
};
const EDITABLE = Object.keys(DEFAULTS);

let cache = null;
function load() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  cache = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS) cache[r.key] = r.value;
  return cache;
}
const all = () => cache || load();
const get = (k) => all()[k];
const bool = (k) => get(k) === '1';
function set(obj) {
  const st = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  db.transaction(() => { for (const [k, v] of Object.entries(obj)) if (EDITABLE.includes(k)) st.run(k, String(v ?? '')); })();
  cache = null;
}
const langs = () => { const l = get('available_langs').split(',').filter((x) => ['ar', 'fr'].includes(x)); return l.length ? l : ['ar']; };

module.exports = { all, get, bool, set, langs, EDITABLE, DEFAULTS, reset: () => { cache = null; } };
