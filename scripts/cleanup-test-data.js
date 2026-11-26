'use strict';
// One-off cleanup of the data that tests/e2e.test.js wrote into a REAL database (this happens when a local .env points
// DATABASE_URL at the hosted Turso database). It only touches rows that belong to the test accounts
// (boss, ed, jo, jo2, lockme, adm, adsman, newj - each with an @t.io e-mail address).
//
//   node scripts/cleanup-test-data.js            dry run: prints what would be deleted, deletes nothing
//   node scripts/cleanup-test-data.js --apply    deletes it
const db = require('../src/db');
const config = require('../src/config');
const settings = require('../src/lib/settings');
const M = require('../src/lib/media');

const APPLY = process.argv.includes('--apply');
const TEST_USERS = ['boss', 'ed', 'jo', 'jo2', 'lockme', 'adm', 'adsman', 'newj'];
// values written by the "settings are editable" test; reset only if they are still exactly these
const TEST_SETTINGS = {
  site_name_ar: 'اسم جديد', site_name_fr: 'Nouveau nom', description_ar: 'د', description_fr: 'd',
  contact_email: 'c@t.io', phone: '+222', color_primary: '#112233', color_primary_dark: '#001122',
};

const ids = (rows, k = 'id') => rows.map((r) => Number(r[k]));
const q = (a) => `(${a.length ? a.join(',') : '0'})`; // ids start at 1, so IN (0) matches nothing

async function main() {
  const target = config.databaseUrl.startsWith('file:') ? config.databaseUrl : new URL(config.databaseUrl.replace(/^libsql:/, 'https:')).host;
  console.log(`Database : ${target}`);
  console.log(`Mode     : ${APPLY ? 'APPLY (deleting)' : 'dry run (nothing is deleted)'}\n`);

  const users = await db.prepare(`SELECT id, username FROM users WHERE lower(username) IN (${TEST_USERS.map(() => '?').join(',')}) AND lower(email) = lower(username) || '@t.io'`).all(...TEST_USERS);
  const uid = ids(users);
  const arts = ids(await db.prepare(`SELECT id FROM articles WHERE author_id IN ${q(uid)}`).all());
  const ads = ids(await db.prepare(`SELECT id FROM advertisements WHERE created_by IN ${q(uid)}`).all());
  const media = await db.prepare(`SELECT * FROM media m WHERE (m.uploaded_by IN ${q(uid)} OR m.file = 'a.webp')
    AND NOT EXISTS (SELECT 1 FROM articles x WHERE x.image_id = m.id AND x.id NOT IN ${q(arts)})
    AND NOT EXISTS (SELECT 1 FROM advertisements x WHERE x.image_id = m.id AND x.id NOT IN ${q(ads)})
    AND NOT EXISTS (SELECT 1 FROM categories x WHERE x.image_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM users x WHERE x.avatar IN (m.file, m.thumb) AND x.id NOT IN ${q(uid)})
    AND NOT EXISTS (SELECT 1 FROM article_translations t WHERE t.article_id NOT IN ${q(arts)} AND t.content LIKE '%' || m.file || '%')`).all();
  const cur = Object.fromEntries((await db.prepare('SELECT key, value FROM settings').all()).map((r) => [r.key, r.value]));
  const reset = Object.fromEntries(Object.keys(TEST_SETTINGS).filter((k) => cur[k] === TEST_SETTINGS[k]).map((k) => [k, settings.DEFAULTS[k]]));
  const links = [...arts.map((i) => `/admin/articles/${i}`), ...ads.map((i) => `/admin/ads/${i}`), ...uid.map((i) => `/admin/users/${i}`)];

  console.log(`Test users      : ${users.map((u) => u.username).join(', ') || 'none'}`);
  console.log(`Test articles   : ${arts.length}  (ids ${arts.join(', ') || '-'})`);
  console.log(`Test ads        : ${ads.length}`);
  console.log(`Test media rows : ${media.length}`);
  console.log(`Settings reset  : ${Object.keys(reset).join(', ') || 'none (already changed or never touched)'}`);

  if (!users.length && !Object.keys(reset).length) { console.log('\nNothing to clean.'); return; }
  if (!APPLY) { console.log('\nDry run only. Check the numbers above, then run again with --apply.'); return; }

  await db.transaction(async () => {
    if (arts.length) {
      const tagIds = ids(await db.prepare(`SELECT DISTINCT tag_id FROM article_tags WHERE article_id IN ${q(arts)}`).all(), 'tag_id');
      for (const t of ['article_translations', 'article_revisions', 'article_tags', 'article_views', 'comments']) await db.prepare(`DELETE FROM ${t} WHERE article_id IN ${q(arts)}`).run();
      await db.prepare(`DELETE FROM articles WHERE id IN ${q(arts)}`).run();
      if (tagIds.length) { // only tags that were used by nothing but the deleted articles
        await db.prepare(`DELETE FROM tag_translations WHERE tag_id IN ${q(tagIds)} AND tag_id NOT IN (SELECT tag_id FROM article_tags)`).run();
        await db.prepare(`DELETE FROM tags WHERE id IN ${q(tagIds)} AND id NOT IN (SELECT tag_id FROM article_tags)`).run();
      }
    }
    if (ads.length) {
      await db.prepare(`DELETE FROM advertisement_statistics WHERE ad_id IN ${q(ads)}`).run();
      await db.prepare(`DELETE FROM advertisements WHERE id IN ${q(ads)}`).run();
    }
    if (media.length) await db.prepare(`DELETE FROM media WHERE id IN ${q(ids(media))}`).run();
    if (links.length) await db.prepare(`DELETE FROM notifications WHERE link IN (${links.map(() => '?').join(',')})`).run(...links);
    if (uid.length) {
      await db.prepare(`UPDATE media SET uploaded_by = NULL WHERE uploaded_by IN ${q(uid)}`).run();
      await db.prepare(`UPDATE articles SET reviewed_by = NULL WHERE reviewed_by IN ${q(uid)}`).run();
      await db.prepare(`UPDATE advertisements SET created_by = NULL WHERE created_by IN ${q(uid)}`).run();
      for (const t of ['sessions', 'user_roles', 'user_permissions', 'notifications', 'audit_logs']) await db.prepare(`DELETE FROM ${t} WHERE user_id IN ${q(uid)}`).run();
      await db.prepare(`DELETE FROM login_attempts WHERE lower(identifier) IN (${TEST_USERS.map(() => '?').join(',')})`).run(...TEST_USERS);
      await db.prepare(`DELETE FROM users WHERE id IN ${q(uid)}`).run();
    }
  })();
  if (Object.keys(reset).length) await settings.set(reset);
  for (const m of media) await M.deleteMediaFiles(m); // uploaded files (Vercel Blob / disk); missing files are ignored
  console.log('\nDone. The test accounts and test content are gone.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
