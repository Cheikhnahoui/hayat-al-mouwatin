'use strict';
// DEVELOPMENT ONLY demo content (articles from the original prototype, demo staff accounts, demo ads).
// Refuses to run in production unless --force is passed. Demo accounts get random passwords printed once.
const crypto = require('crypto');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('./index');
const { seed } = require('./seed');
const { hashPassword } = require('../lib/auth');
const { slugify } = require('../lib/util');
const data = require('./demo-data.json');

if (config.isProd && !process.argv.includes('--force')) {
  console.error('Refusing to load demo data in production. Pass --force if you really want to.');
  process.exit(1);
}
async function main() {
await seed();
if ((await db.prepare("SELECT 1 FROM users WHERE username LIKE 'demo\\_%' ESCAPE '\\'").get())) {
  console.error('Demo data already present. Delete data/hayat.db to start over.');
  process.exit(1);
}

const roleId = async (k) => (await db.prepare('SELECT id FROM roles WHERE key = ?').get(k)).id;
const staff = [
  ['demo_admin', 'admin', 'مدير الموقع (تجريبي)', 'Administrateur (démo)'],
  ['demo_editor', 'editor', 'رئيس التحرير (تجريبي)', 'Rédacteur en chef (démo)'],
  ['demo_ads', 'ad_manager', 'مسؤول الإعلانات (تجريبي)', 'Resp. publicité (démo)'],
];
const creds = [];
const mkUser = async (username, role, ar, fr) => {
  const pw = crypto.randomBytes(9).toString('base64url') + '7';
  const id = (await db.prepare('INSERT INTO users (username, email, password_hash, name_ar, name_fr) VALUES (?,?,?,?,?)').run(username, `${username}@demo.invalid`, hashPassword(pw), ar, fr)).lastInsertRowid;
  (await db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)').run(id, (await roleId(role))));
  creds.push([username, role, pw]);
  return id;
};
for (const s of staff) (await mkUser(...s));

const authors = {};
for (const [i, name] of [...new Set(data.articles.map((a) => a.author))].entries()) {
  authors[name] = (await mkUser(`demo_journalist${i + 1}`, 'journalist', name, name));
}

const catId = async (key) => {
  const k = key === 'intl' ? 'international' : key === 'sport' ? 'sports' : key === 'tech' ? 'technology' : key;
  return (await db.prepare('SELECT id FROM categories WHERE key = ?').get(k)).id;
};
const para = (s) => s.split('\n').map((p) => `<p>${p.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>`).join('');

for (const [i, a] of data.articles.entries()) {
  const type = a.opinion ? 'opinion' : 'news';
  const pub = `${a.date} ${String(14 - (i % 6)).padStart(2, '0')}:${String(10 + i * 3).padStart(2, '0')}:00`;
  const id = (await db.prepare(`INSERT INTO articles (author_id, category_id, type, status, featured_slot, is_breaking, published_at, view_count, comments_enabled)
    VALUES (?,?,?,'published',?,?,?,?,1)`).run(authors[a.author], (await catId(a.cat)), type, i === 0 ? 'main' : i === 1 || i === 2 ? 'secondary' : null, i < 5 && !a.opinion ? 1 : 0, pub, a.views)).lastInsertRowid;
  const ins = db.prepare('INSERT INTO article_translations (article_id, lang, title, slug, summary, content, seo_title, seo_description) VALUES (?,?,?,?,?,?,?,?)');
  const sum = (b) => b.split('\n')[0].slice(0, 220);
  (await ins.run(id, 'ar', a.title_ar, slugify(a.title_ar), sum(a.body_ar), para(a.body_ar), '', ''));
  // demo of "single-language" publishing: the last two opinion pieces are Arabic-only
  if (!(a.opinion && i >= data.articles.length - 2)) (await ins.run(id, 'fr', a.title_fr, slugify(a.title_fr), sum(a.body_fr), para(a.body_fr), '', ''));
  (await db.prepare("INSERT INTO article_views (article_id, day, views) VALUES (?, date('now'), ?)").run(id, Math.round(a.views / 40)));
}

// demo ad banners (generated, latin text only)
const mkBanner = async (w, h, label, hue) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g"><stop offset="0" stop-color="hsl(${hue},45%,35%)"/><stop offset="1" stop-color="hsl(${hue + 40},50%,15%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" fill="#fff" font-size="${Math.round(h / 5)}" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle" opacity=".85">${label}</text></svg>`;
  const name = crypto.randomBytes(8).toString('hex') + '.webp';
  const info = await sharp(Buffer.from(svg)).webp({ quality: 80 }).toFile(path.join(config.uploadDir, name));
  return (await db.prepare(`INSERT INTO media (kind, file, thumb, medium, original_name, mime, size, width, height, folder, alt_ar, alt_fr) VALUES ('image',?,?,?,?,?,?,?,?,'ads','إعلان تجريبي','Publicité démo')`)
    .run(name, name, name, label + '.webp', 'image/webp', info.size, w, h)).lastInsertRowid;
};
  {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const ads = [['home_top', 970, 120, 'DEMO AD 970x120', 200], ['home_sidebar', 300, 250, 'DEMO AD 300x250', 20], ['article_below', 728, 120, 'DEMO AD 728x120', 100], ['footer', 970, 90, 'DEMO AD 970x90', 280]];
  for (const [pl, w, h, label, hue] of ads) {
    const mid = await mkBanner(w, h, label, hue);
    (await db.prepare(`INSERT INTO advertisements (title, placement, image_id, destination_url, start_at, end_at, is_active) VALUES (?,?,?,?,datetime('now','-1 day'),datetime('now','+60 days'),1)`)
      .run('Demo ' + pl, pl, mid, 'https://example.com/'));
  }
  console.log('\nDemo data loaded (11 articles, demo staff, 4 demo ads).');
  console.log('Demo accounts (printed once - note them down). Create your real Super Admin with `npm run create-admin`:\n');
  for (const [u, r, p] of creds.filter((c) => !c[0].startsWith('demo_journalist') || c[0] === 'demo_journalist1')) console.log(`  ${u.padEnd(20)} ${r.padEnd(11)} ${p}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
