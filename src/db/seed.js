'use strict';
// Production seed: roles, permissions, categories, default settings. Idempotent. Contains NO users and NO demo content.
const db = require('./index');
const { PERMISSIONS, ROLES } = require('../lib/rbac');
const settings = require('../lib/settings');
const { slugify } = require('../lib/util');

const CATEGORIES = [
  { key: 'national', ar: 'الوطنية', fr: 'National', hue: 345, slug_ar: 'وطنية', slug_fr: 'national' },
  { key: 'international', ar: 'الدولية', fr: 'International', hue: 210, slug_ar: 'دولية', slug_fr: 'international' },
  { key: 'politics', ar: 'السياسة', fr: 'Politique', hue: 15, slug_ar: 'سياسة', slug_fr: 'politique' },
  { key: 'economy', ar: 'الاقتصاد', fr: 'Économie', hue: 40, slug_ar: 'اقتصاد', slug_fr: 'economie' },
  { key: 'society', ar: 'المجتمع', fr: 'Société', hue: 130, slug_ar: 'مجتمع', slug_fr: 'societe' },
  { key: 'sports', ar: 'الرياضة', fr: 'Sport', hue: 100, slug_ar: 'رياضة', slug_fr: 'sport' },
  { key: 'culture', ar: 'الثقافة', fr: 'Culture', hue: 285, slug_ar: 'ثقافة', slug_fr: 'culture' },
  { key: 'technology', ar: 'التكنولوجيا', fr: 'Technologie', hue: 190, slug_ar: 'تكنولوجيا', slug_fr: 'technologie' },
];

async function seed() {
  (await db.migrate());
  (await db.transaction(async () => {
    const insPerm = db.prepare('INSERT INTO permissions (key, description) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET description = excluded.description');
    for (const [k, d] of Object.entries(PERMISSIONS)) (await insPerm.run(k, d));
    const insRole = db.prepare('INSERT INTO roles (key, name_ar, name_fr) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET name_ar = excluded.name_ar, name_fr = excluded.name_fr');
    const link = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.key = ? AND p.key = ?');
    for (const [k, r] of Object.entries(ROLES)) {
      (await insRole.run(k, r.ar, r.fr));
      for (const p of r.perms) (await link.run(k, p));
    }
    if (!(await db.prepare('SELECT 1 FROM categories LIMIT 1').get())) {
      for (const [i, c] of CATEGORIES.entries()) {
        const id = (await db.prepare('INSERT INTO categories (key, hue, sort_order) VALUES (?,?,?)').run(c.key, c.hue, i + 1)).lastInsertRowid;
        const t = db.prepare('INSERT INTO category_translations (category_id, lang, name, slug, description) VALUES (?,?,?,?,?)');
        (await t.run(id, 'ar', c.ar, c.slug_ar, `آخر أخبار ${c.ar}`));
        (await t.run(id, 'fr', c.fr, c.slug_fr, `Toute l’actualité : ${c.fr}`));
      }
    }
  })());
  // make sure every default setting exists in DB so it shows up in the settings screen
  const have = new Set((await db.prepare('SELECT key FROM settings').all()).map((r) => r.key));
  const missing = Object.fromEntries(Object.entries(settings.DEFAULTS).filter(([k]) => !have.has(k)));
  (await settings.set(missing));
}
// Cheap start-up check for serverless cold starts: run the (many-statement) seed only when the
// role / permission definitions changed since the last run.
async function ensureSeeded() {
  await db.migrate();
  const version = require('crypto').createHash('sha1').update(JSON.stringify([PERMISSIONS, ROLES, CATEGORIES, 1])).digest('hex');
  const row = await db.prepare("SELECT value FROM settings WHERE key = '_seed_version'").get();
  if (row && row.value === version) return false;
  await seed();
  await db.prepare("INSERT INTO settings (key, value) VALUES ('_seed_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(version);
  return true;
}
module.exports = { seed, ensureSeeded, CATEGORIES };

if (require.main === module) {
  seed().then(() => {
    console.log('Seed complete: roles, permissions, categories and default settings are in place.');
    console.log('Next: create the first Super Admin with `npm run create-admin`.');
  }).catch((e) => { console.error(e); process.exit(1); });
}
