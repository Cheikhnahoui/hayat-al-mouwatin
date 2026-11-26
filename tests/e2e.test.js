'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'), fs = require('fs'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'up');
process.env.SITE_URL = 'http://test.local';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const { createApp, ready } = require('../src/server');
const auth = require('../src/lib/auth');
const articles = require('../src/lib/articles');
const util = require('../src/lib/util');
const sharp = require('sharp');

let base, server;
const PW = 'Passw0rd-test1';
const mkUser = async (username, role) => {
  const id = (await db.prepare('INSERT INTO users (username,email,password_hash,name_ar,name_fr) VALUES (?,?,?,?,?)').run(username, `${username}@t.io`, auth.hashPassword(PW), username, username)).lastInsertRowid;
  (await db.prepare('INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE key = ?').run(id, role));
  return id;
};
class Client {
  constructor() { this.jar = {}; }
  async req(p, opt = {}) {
    const headers = { cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(opt.headers || {}) };
    const r = await fetch(base + p, { redirect: 'manual', ...opt, headers });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.jar[kv.slice(0, i)] = kv.slice(i + 1); }
    r.text_ = await r.text();
    return r;
  }
  get(p) { return this.req(p); }
  post(p, body) {
    return this.req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  }
  async login(u, pw = PW) {
    const r = await this.get('/admin/login');
    const lc = r.text_.match(/name="lc" value="([^"]+)"/)[1];
    const l = await this.post('/admin/login', { identifier: u, password: pw, lc });
    const page = await this.get('/admin');
    this.csrf = page.text_.match(/data-csrf="([^"]+)"/)?.[1];
    return l;
  }
  p(path, body) { return this.post(path, { _csrf: this.csrf, ...body }); }
  multipart(path, fd) { return this.req(`${path}${path.includes('?') ? '&' : '?'}_csrf=${encodeURIComponent(this.csrf)}`, { method: 'POST', body: fd }); }
}
const idFrom = (r, re) => +r.headers.get('location').match(re)[1];

test.before(async () => {
  await ready();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [u, r] of [['boss', 'super_admin'], ['ed', 'editor'], ['jo', 'journalist'], ['jo2', 'journalist'], ['lockme', 'journalist'], ['adm', 'admin'], ['adsman', 'ad_manager']]) (await mkUser(u, r));
});
test.after(() => { server.close(); });

test('login: wrong password, success, lockout after repeated failures', async () => {
  const c = new Client();
  assert.equal((await c.login('jo', 'bad-password-1')).status, 401);
  assert.equal((await c.login('jo')).status, 302);
  const d = new Client();
  for (let i = 0; i < 5; i++) await d.login('lockme', 'wrong-pass-1');
  assert.equal((await d.login('lockme')).status, 423);
});

test('anonymous users are redirected; CSRF token is enforced', async () => {
  assert.equal((await new Client().get('/admin/articles')).status, 302);
  const ed = new Client(); await ed.login('ed');
  assert.equal((await ed.post('/admin/articles', { title_ar: 'x', content_ar: '<p>y</p>', category_id: 1 })).status, 403);
});

test('RBAC enforced on the backend', async () => {
  const jo = new Client(); await jo.login('jo');
  for (const p of ['/admin/users', '/admin/settings', '/admin/categories', '/admin/audit', '/admin/ads', '/admin/analytics', '/admin/comments']) assert.equal((await jo.get(p)).status, 403, p);
  assert.equal((await jo.get('/admin/articles')).status, 200);
  const ad = new Client(); await ad.login('adsman');
  assert.equal((await ad.get('/admin/articles')).status, 403);
  assert.equal((await ad.get('/admin/ads')).status, 200);
  const adm = new Client(); await adm.login('adm');
  assert.equal((await adm.get('/admin/settings')).status, 403);
  assert.equal((await adm.get('/admin/categories')).status, 200);
  const boss = new Client(); await boss.login('boss');
  assert.equal((await boss.get('/admin/settings')).status, 200);
  assert.equal((await boss.get('/admin/audit')).status, 200);
});

let artId;
test('workflow: journalist -> submit -> editor approves -> public (Arabic only)', async () => {
  const jo = new Client(); await jo.login('jo');
  const r = await jo.p('/admin/articles', { title_ar: 'عنوان اختبار', summary_ar: 'ملخص', content_ar: '<p>فقرة أولى</p><p>فقرة ثانية</p><script>alert(1)</script><img src="x" onerror="alert(1)"><h2>عنوان</h2>', enabled_ar: '1', category_id: '1', type: 'news', comments_enabled: '1', tags_ar: 'وسم1, وسم2' });
  assert.equal(r.status, 302);
  artId = idFrom(r, /articles\/(\d+)/);
  const row = (await db.prepare('SELECT content FROM article_translations WHERE article_id=? AND lang=?').get(artId, 'ar'));
  assert.ok(!/script|onerror/i.test(row.content), 'content sanitized');
  assert.equal((await jo.p(`/admin/articles/${artId}/publish`, {})).status, 403);
  assert.equal((await jo.p(`/admin/articles/${artId}/approve`, {})).status, 403);
  assert.equal((await new Client().get(`/ar/article/${artId}-x`)).status, 404);
  await jo.p(`/admin/articles/${artId}/submit`, {});
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(artId)).status, 'pending');
  const edId = (await db.prepare("SELECT id FROM users WHERE username='ed'").get()).id;
  assert.ok((await db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='article_submitted'").get(edId)));
  assert.equal((await jo.p(`/admin/articles/${artId}/save`, { title_ar: 'x', content_ar: '<p>z</p>', category_id: 1 })).status, 403);
  const ed = new Client(); await ed.login('ed');
  await ed.p(`/admin/articles/${artId}/approve`, {});
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(artId)).status, 'published');
  const joId = (await db.prepare("SELECT id FROM users WHERE username='jo'").get()).id;
  assert.ok((await db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='article_approved'").get(joId)));
  assert.ok((await db.prepare('SELECT COUNT(*) n FROM article_revisions WHERE article_id=?').get(artId)).n >= 3);
});

test('public article page: SEO, hreflang, JSON-LD, missing-translation notice', async () => {
  const c = new Client();
  const slug = (await db.prepare("SELECT slug FROM article_translations WHERE article_id=? AND lang='ar'").get(artId)).slug;
  const r = await c.get(`/ar/article/${artId}-${encodeURIComponent(slug)}`);
  assert.equal(r.status, 200);
  assert.match(r.text_, /dir="rtl"/); assert.match(r.text_, /NewsArticle/); assert.match(r.text_, /rel="canonical"/); assert.match(r.text_, /hreflang="ar"/); assert.match(r.text_, /og:title/);
  assert.ok(!/<link rel="alternate" hreflang="fr"/.test(r.text_), 'no fr alternate for ar-only article');
  assert.equal((await c.get(`/ar/article/${artId}-wrong-slug`)).status, 301);
  const fr = await c.get(`/fr/article/${artId}`);
  assert.equal(fr.status, 200); assert.match(fr.text_, /pas encore de version française/); assert.match(fr.text_, /noindex/);
  assert.equal((await db.prepare('SELECT view_count FROM articles WHERE id=?').get(artId)).view_count, 1);
  const sm = await c.get('/sitemap.xml');
  assert.match(sm.text_, new RegExp(`/ar/article/${artId}-`)); assert.ok(!sm.text_.includes(`/fr/article/${artId}-`));
  assert.ok(!(await c.get('/fr')).text_.includes('عنوان اختبار'));
  assert.match((await c.get('/ar/search?q=' + encodeURIComponent('اختبار'))).text_, /عنوان اختبار/);
});

test('bilingual article: French version added, language switcher and hreflang', async () => {
  const ed = new Client(); await ed.login('ed');
  const r = await ed.p(`/admin/articles/${artId}/save`, { title_ar: 'عنوان اختبار', content_ar: '<p>أ</p>', enabled_ar: '1', title_fr: 'Titre test', content_fr: '<p>Bonjour</p>', enabled_fr: '1', category_id: '1', type: 'news', comments_enabled: '1' });
  assert.equal(r.status, 302);
  const fr = await new Client().get(`/fr/article/${artId}-titre-test`);
  assert.equal(fr.status, 200); assert.match(fr.text_, /dir="ltr"/); assert.match(fr.text_, /hreflang="ar"/); assert.match(fr.text_, /hreflang="fr"/);
  assert.match(fr.text_, /class="langbtn" href="\/ar\/article\/\d+-/);
});

test('featured slot & breaking ticker are editor-controlled and shown on home', async () => {
  const ed = new Client(); await ed.login('ed');
  await ed.p(`/admin/articles/${artId}/feature`, { slot: 'main', breaking: '1' });
  const home = (await new Client().get('/ar')).text_;
  assert.match(home, /class="brk"/);
  assert.match(home.split('class="hero"')[1].slice(0, 1500), /عنوان اختبار/);
  const jo = new Client(); await jo.login('jo');
  assert.equal((await jo.p(`/admin/articles/${artId}/feature`, { slot: 'main' })).status, 403);
});

test('scheduled publication', async () => {
  const ed = new Client(); await ed.login('ed');
  const r = await ed.p('/admin/articles', { title_fr: 'Programmé', content_fr: '<p>x</p>', enabled_fr: '1', category_id: '2', type: 'news' });
  const id = idFrom(r, /articles\/(\d+)/);
  const future = new Date(Date.now() + 3600e3).toISOString().slice(0, 16);
  await ed.p(`/admin/articles/${id}/schedule`, { publish_at: future });
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(id)).status, 'scheduled');
  assert.equal((await new Client().get(`/fr/article/${id}-programme`)).status, 404);
  (await db.prepare("UPDATE articles SET publish_at = datetime('now','-1 minute') WHERE id=?").run(id));
  assert.equal((await articles.publishDue()), 1);
  assert.equal((await new Client().get(`/fr/article/${id}-programme`)).status, 200);
  const past = await ed.p(`/admin/articles/${id}/schedule`, { publish_at: '2020-01-01T10:00' });
  assert.match(past.headers.get('location'), /e=/);
});

test('reject with note, unpublish, archive and restore', async () => {
  const jo = new Client(); await jo.login('jo');
  const r = await jo.p('/admin/articles', { title_ar: 'مقال للرفض', content_ar: '<p>x</p>', enabled_ar: '1', category_id: '1' });
  const id = idFrom(r, /articles\/(\d+)/);
  await jo.p(`/admin/articles/${id}/submit`, {});
  const ed = new Client(); await ed.login('ed');
  await ed.p(`/admin/articles/${id}/reject`, { note: 'أضف مصادر' });
  const a = (await db.prepare('SELECT status, review_note FROM articles WHERE id=?').get(id));
  assert.equal(a.status, 'rejected'); assert.equal(a.review_note, 'أضف مصادر');
  await ed.p(`/admin/articles/${artId}/unpublish`, {});
  assert.equal((await new Client().get('/ar/article/' + artId)).status, 404);
  await ed.p(`/admin/articles/${artId}/publish`, {});
  await ed.p(`/admin/articles/${artId}/archive`, {});
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(artId)).status, 'archived');
  await ed.p(`/admin/articles/${artId}/restore`, {});
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(artId)).status, 'published');
});

test("a journalist cannot read or delete another journalist's article", async () => {
  const jo = new Client(); await jo.login('jo');
  const r = await jo.p('/admin/articles', { title_ar: 'سري', content_ar: '<p>x</p>', category_id: '1' });
  const id = idFrom(r, /articles\/(\d+)/);
  const j2 = new Client(); await j2.login('jo2');
  assert.equal((await j2.get(`/admin/articles/${id}`)).status, 403);
  assert.equal((await j2.p(`/admin/articles/${id}/delete`, {})).status, 403);
});

test('media upload validates real file type and optimizes images', async () => {
  const boss = new Client(); await boss.login('boss');
  const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#8b1220' } }).png().toBuffer();
  const send = (buf, name, type) => { const fd = new FormData(); fd.append('files', new Blob([buf], { type }), name); return boss.multipart('/admin/media/upload?json=1', fd); };
  const ok = JSON.parse((await send(png, 'photo.png', 'image/png')).text_);
  assert.equal(ok.ok, 1);
  const m = (await db.prepare('SELECT * FROM media WHERE id=?').get(ok.items[0].id));
  assert.match(m.file, /\.webp$/); assert.ok(m.thumb && m.medium);
  assert.equal((await new Client().get('/uploads/' + m.thumb)).status, 200);
  assert.equal(JSON.parse((await send(Buffer.from('<?php echo 1; ?> this is not an image at all'), 'evil.png', 'image/png')).text_).ok, 0);
  assert.equal(JSON.parse((await send(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg', 'image/svg+xml')).text_).ok, 0);
});

test('advertisements: impressions, clicks, date window, URL validation', async () => {
  const ad = new Client(); await ad.login('adsman');
  const media = (await db.prepare("INSERT INTO media (kind,file,thumb,medium,mime,size,folder) VALUES ('image','a.webp','a.webp','a.webp','image/webp',1,'ads')").run()).lastInsertRowid;
  const r = await ad.p('/admin/ads', { title: 'Promo', placement: 'footer', destination_url: 'https://example.org/x', image_id: String(media), is_active: '1' });
  assert.equal(r.status, 302);
  const id = idFrom(r, /ads\/(\d+)/);
  const c = new Client();
  assert.match((await c.get('/ar')).text_, new RegExp(`/ad/${id}/click`));
  const click = await c.get(`/ad/${id}/click`);
  assert.equal(click.status, 302); assert.equal(click.headers.get('location'), 'https://example.org/x');
  const st = (await db.prepare('SELECT SUM(impressions) i, SUM(clicks) c FROM advertisement_statistics WHERE ad_id=?').get(id));
  assert.ok(st.i >= 1); assert.equal(st.c, 1);
  (await db.prepare("UPDATE advertisements SET end_at = datetime('now','-1 day') WHERE id=?").run(id));
  assert.ok(!(await c.get('/ar')).text_.includes(`/ad/${id}/click`), 'expired ad hidden');
  const bad = await ad.p('/admin/ads', { title: 'Bad', placement: 'footer', destination_url: 'javascript:alert(1)', image_id: String(media) });
  assert.equal(bad.status, 200); assert.match(bad.text_, /flash err/);
});

test('comments: moderation queue, honeypot, spam, rate limit, reports', async () => {
  const c = new Client();
  const slug = (await db.prepare("SELECT slug FROM article_translations WHERE article_id=? AND lang='ar'").get(artId)).slug;
  const url = `/ar/article/${artId}-${encodeURIComponent(slug)}`;
  const ft = (await c.get(url)).text_.match(/name="ft" value="([^"]+)"/)[1];
  let r = await c.post(`/ar/article/${artId}/comment`, { ft, name: 'Ali', body: 'تعليق جيد' });
  assert.match(r.headers.get('location'), /c=err/, 'too fast');
  const old = `${Date.now() - 10000}`; const good = `${old}.${util.hmac('ft' + old)}`;
  r = await c.post(`/ar/article/${artId}/comment`, { ft: good, name: 'Ali', body: 'تعليق جيد' });
  assert.match(r.headers.get('location'), /c=pending/);
  r = await c.post(`/ar/article/${artId}/comment`, { ft: good, name: 'Bot', body: 'hello', website: 'http://spam' });
  assert.match(r.headers.get('location'), /c=pending/, 'bots get a silent fake success');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM comments WHERE author_name='Bot'").get()).n, 0);
  await c.post(`/ar/article/${artId}/comment`, { ft: good, name: 'Spammer', body: 'buy http://a.com http://b.com' });
  assert.equal((await db.prepare("SELECT status FROM comments WHERE author_name='Spammer'").get()).status, 'spam');
  await c.post(`/ar/article/${artId}/comment`, { ft: good, name: 'Ali3', body: 'ثالث' });
  r = await c.post(`/ar/article/${artId}/comment`, { ft: good, name: 'Ali4', body: 'رابع' });
  assert.match(r.headers.get('location'), /c=rate/);
  assert.ok(!(await c.get(url)).text_.includes('تعليق جيد'), 'pending comment hidden');
  const adm = new Client(); await adm.login('adm');
  const cid = (await db.prepare("SELECT id FROM comments WHERE author_name='Ali'").get()).id;
  await adm.p(`/admin/comments/${cid}/approve`, {});
  assert.match((await c.get(url)).text_, /تعليق جيد/);
  for (let i = 0; i < 3; i++) await c.post(`/ar/comments/${cid}/report`, { back: url });
  assert.equal((await db.prepare('SELECT status FROM comments WHERE id=?').get(cid)).status, 'pending');
});

test('user management: escalation guard, password reset, forced change', async () => {
  const adm = new Client(); await adm.login('adm');
  let r = await adm.p('/admin/users', { username: 'newj', email: 'newj@t.io', name_ar: 'ن', password: 'Strong-pass-123', is_active: '1' });
  assert.equal(r.status, 200);
  const roles = (await db.prepare("SELECT r.key FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users u ON u.id=ur.user_id WHERE u.username='newj'").all()).map((x) => x.key);
  assert.deepEqual(roles, ['journalist']);
  const bossId = (await db.prepare("SELECT id FROM users WHERE username='boss'").get()).id;
  assert.equal((await adm.p(`/admin/users/${bossId}`, { email: 'x@x.io', is_active: '1' })).status, 403);
  assert.equal((await adm.p(`/admin/users/${bossId}/reset-password`, {})).status, 403);
  const boss = new Client(); await boss.login('boss');
  const nid = (await db.prepare("SELECT id FROM users WHERE username='newj'").get()).id;
  r = await boss.p(`/admin/users/${nid}/reset-password`, {});
  const tmpPw = r.text_.match(/<code>([^<]+)<\/code>/)[1];
  const nj = new Client(); await nj.login('newj', tmpPw);
  assert.match((await nj.get('/admin')).headers.get('location') || '', /profile/);
  r = await boss.p(`/admin/users/${bossId}`, { email: 'boss@t.io' }); // not is_active -> would deactivate last super admin
  assert.match(r.text_, /flash err/);
  await boss.p(`/admin/users/${nid}`, { email: 'newj@t.io', roles: 'journalist' }); // is_active missing => deactivate
  assert.equal((await nj.get('/admin')).status, 302);
});

test('settings are editable without code changes and validated', async () => {
  const boss = new Client(); await boss.login('boss');
  const s = { site_name_ar: 'اسم جديد', site_name_fr: 'Nouveau nom', description_ar: 'د', description_fr: 'd', contact_email: 'c@t.io', phone: '+222', color_primary: '#112233', color_primary_dark: '#001122', default_lang: 'ar', lang_ar: '1', lang_fr: '1', sec_hero: '1', ord_hero: '1', sec_latest: '1', ord_latest: '2', comments_mode: 'moderated', breaking_mode: 'flagged', comments_max_links: '1', breaking_count: '5', ads_enabled: '1', comments_enabled: '1', breaking_enabled: '1' };
  const fd = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
  let r = await boss.multipart('/admin/settings', fd(s));
  assert.match(r.headers.get('location'), /m=saved/);
  const home = (await new Client().get('/ar')).text_;
  assert.match(home, /اسم جديد/); assert.match(home, /--red:#112233/);
  r = await boss.multipart('/admin/settings', fd({ ...s, color_primary: 'red;}</style><script>' }));
  assert.match(r.text_, /flash err/);
  await boss.multipart('/admin/settings', fd({ ...s, lang_fr: '' }));
  assert.equal((await new Client().get('/fr')).status, 302);
});

test('security headers', async () => {
  const r = await new Client().get('/ar');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await new Client().get('/admin/login')).headers.get('cache-control'), 'no-store');
});

// ===================== every way of publishing a news article =====================
test('setup: re-enable both languages after the settings test', async () => {
  const settings = require('../src/lib/settings');
  await settings.set({ available_langs: 'ar,fr', default_lang: 'ar', home_sections: settings.DEFAULTS.home_sections });
  assert.deepEqual(settings.langs(), ['ar', 'fr']);
});

const png = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#8b1220' } }).png().toBuffer();
async function uploadImage(client) {
  const fd = new FormData(); fd.append('files', new Blob([await png()], { type: 'image/png' }), 'photo.png');
  const r = JSON.parse((await client.multipart('/admin/media/upload?json=1', fd)).text_);
  return r.items[0].id;
}
const slugOf = async (id, lang) => (await db.prepare('SELECT slug FROM article_translations WHERE article_id=? AND lang=?').get(id, lang)).slug;
const pubPath = async (id, lang) => `/${lang}/article/${id}-${encodeURIComponent(await slugOf(id, lang))}`;

test('publish method 1: super admin writes in Arabic only, with image + tags, publishes immediately', async () => {
  const boss = new Client(); await boss.login('boss');
  const img = await uploadImage(boss);
  const r = await boss.p('/admin/articles', { title_ar: 'خبر عربي مباشر', summary_ar: 'ملخص', content_ar: '<h2>عنوان</h2><p>نص</p><blockquote>اقتباس</blockquote>', enabled_ar: '1', category_id: '3', type: 'news', image_id: String(img), tags_ar: 'اختبار, نشر', comments_enabled: '1' });
  const id = idFrom(r, /articles\/(\d+)/);
  assert.equal((await boss.p(`/admin/articles/${id}/publish`, {})).status, 302);
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(id)).status, 'published');
  const page = await new Client().get(await pubPath(id, 'ar'));
  assert.equal(page.status, 200); assert.match(page.text_, /srcset=/); assert.match(page.text_, /<blockquote>/); assert.match(page.text_, /#اختبار/);
  const cat = (await db.prepare("SELECT slug FROM category_translations WHERE category_id=3 AND lang='ar'").get()).slug;
  const cp = await new Client().get(`/ar/category/${encodeURIComponent(cat)}`);
  assert.equal(cp.status, 200); assert.match(cp.text_, /خبر عربي مباشر/);
  const tag = (await db.prepare("SELECT slug FROM tag_translations WHERE lang='ar' AND name='اختبار'").get()).slug;
  assert.match((await new Client().get(`/ar/tag/${encodeURIComponent(tag)}`)).text_, /خبر عربي مباشر/);
  assert.match((await new Client().get(`/ar/author/${(await db.prepare("SELECT id FROM users WHERE username='boss'").get()).id}`)).text_, /خبر عربي مباشر/);
  assert.ok(!(await new Client().get('/fr')).text_.includes('خبر عربي مباشر'));
  assert.match((await new Client().get(`/fr/article/${id}`)).text_, /pas encore de version française/);
});

test('publish method 2: French only', async () => {
  const boss = new Client(); await boss.login('boss');
  const r = await boss.p('/admin/articles', { title_fr: 'Article français seul', content_fr: '<p>Bonjour</p>', enabled_fr: '1', category_id: '4', type: 'news' });
  const id = idFrom(r, /articles\/(\d+)/);
  await boss.p(`/admin/articles/${id}/publish`, {});
  assert.equal((await new Client().get(await pubPath(id, 'fr'))).status, 200);
  assert.match((await new Client().get(`/ar/article/${id}`)).text_, /الفرنسية/);
  assert.match((await new Client().get('/fr')).text_, /Article français seul/);
});

test('publish method 3: both languages + video type with embedded YouTube; bad video URL rejected', async () => {
  const boss = new Client(); await boss.login('boss');
  const bad = await boss.p('/admin/articles', { title_ar: 'س', content_ar: '<p>x</p>', enabled_ar: '1', category_id: '1', type: 'video', video_url: 'https://evil.example/x' });
  assert.equal(bad.status, 200); assert.match(bad.text_, /flash err/);
  const r = await boss.p('/admin/articles', { title_ar: 'فيديو ثنائي', content_ar: '<p>وصف</p>', enabled_ar: '1', title_fr: 'Vidéo bilingue', content_fr: '<p>Desc</p>', enabled_fr: '1', category_id: '1', type: 'video', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', seo_title_ar: 'عنوان سيو', seo_description_ar: 'وصف سيو' });
  const id = idFrom(r, /articles\/(\d+)/);
  await boss.p(`/admin/articles/${id}/publish`, {});
  const ar = (await new Client().get(await pubPath(id, 'ar'))).text_;
  assert.match(ar, /youtube\.com\/embed\/dQw4w9WgXcQ/); assert.match(ar, /عنوان سيو/);
  const fr = (await new Client().get(await pubPath(id, 'fr'))).text_;
  assert.match(fr, /hreflang="ar"/); assert.match(fr, /hreflang="fr"/);
  assert.match((await new Client().get('/ar')).text_, /فيديو ثنائي/); // video section on home
});

test('publish method 4: editor writes and publishes directly; admin approves a journalist article; reject then resubmit', async () => {
  const ed = new Client(); await ed.login('ed');
  const r1 = await ed.p('/admin/articles', { title_ar: 'من المحرر', content_ar: '<p>x</p>', enabled_ar: '1', category_id: '2', type: 'interview' });
  const id1 = idFrom(r1, /articles\/(\d+)/);
  await ed.p(`/admin/articles/${id1}/publish`, {});
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(id1)).status, 'published');
  const jo = new Client(); await jo.login('jo');
  const r2 = await jo.p('/admin/articles', { title_ar: 'من الصحفي', content_ar: '<p>y</p>', enabled_ar: '1', category_id: '5', type: 'opinion' });
  const id2 = idFrom(r2, /articles\/(\d+)/);
  await jo.p(`/admin/articles/${id2}/submit`, {});
  const adm = new Client(); await adm.login('adm');
  await adm.p(`/admin/articles/${id2}/reject`, { note: 'تعديل' });
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(id2)).status, 'rejected');
  assert.equal((await jo.p(`/admin/articles/${id2}/save`, { title_ar: 'من الصحفي (معدّل)', content_ar: '<p>y2</p>', enabled_ar: '1', category_id: '5', type: 'opinion' })).status, 302);
  await jo.p(`/admin/articles/${id2}/submit`, {});
  await adm.p(`/admin/articles/${id2}/approve`, {});
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(id2)).status, 'published');
  const home = (await new Client().get('/ar')).text_;
  assert.match(home, /من المحرر/); assert.match(home, /من الصحفي \(معدّل\)/);
});

test('publish method 5: schedule from the editor form; delete removes everything', async () => {
  const adm = new Client(); await adm.login('adm');
  const future = new Date(Date.now() + 7200e3).toISOString().slice(0, 16);
  const r = await adm.p('/admin/articles', { title_ar: 'مجدول بالنموذج', content_ar: '<p>x</p>', enabled_ar: '1', category_id: '1', publish_at: future });
  const id = idFrom(r, /articles\/(\d+)/);
  await adm.p(`/admin/articles/${id}/schedule`, { publish_at: future });
  assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').get(id)).status, 'scheduled');
  assert.equal((await new Client().get(`/ar/article/${id}-x`)).status, 404);
  await db.prepare("UPDATE articles SET publish_at = datetime('now','-1 minute') WHERE id=?").run(id);
  assert.equal(await articles.publishDue(), 1);
  assert.equal((await new Client().get(await pubPath(id, 'ar'))).status, 200);
  await adm.p(`/admin/articles/${id}/delete`, {});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM articles WHERE id=?').get(id)).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM article_translations WHERE article_id=?').get(id)).n, 0);
});

test('every public and admin page renders for a super admin (200/redirect only)', async () => {
  const boss = new Client(); await boss.login('boss');
  const cats = await db.prepare('SELECT slug, lang FROM category_translations').all();
  const pages = ['/ar', '/fr', '/ar/search', '/ar/search?q=خبر', '/fr/search?q=a&category=1&from=2026-01-01&to=2027-01-01', '/ar/feed.xml', '/sitemap.xml', '/robots.txt',
    ...cats.map((c) => `/${c.lang}/category/${encodeURIComponent(c.slug)}`), ...cats.map((c) => `/${c.lang}/category/${encodeURIComponent(c.slug)}?page=2`),
    '/admin', '/admin/articles', '/admin/articles/new', '/admin/articles?status=pending', '/admin/categories', '/admin/categories/new', '/admin/categories/1', '/admin/tags', '/admin/media', '/admin/media/list.json',
    '/admin/comments', '/admin/ads', '/admin/ads/new', '/admin/users', '/admin/users/new', '/admin/users/1', '/admin/notifications', '/admin/analytics', '/admin/audit', '/admin/settings', '/admin/profile', '/admin/dashboard', '/admin/news'];
  for (const p of pages) { const r = await boss.get(p); assert.ok(r.status < 400, `${p} -> ${r.status}`); }
});

test('public site no longer links to the admin panel; /ar/admin and /fr/admin redirect to /admin', async () => {
  for (const l of ['ar', 'fr']) {
    const html = (await new Client().get(`/${l}`)).text_;
    assert.ok(!/href="\/admin"/.test(html), `${l} home must not link to /admin`);
    const r = await new Client().get(`/${l}/admin`);
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/admin');
  }
  assert.equal((await new Client().get('/admin')).status, 302); // -> login
  assert.match((await new Client().get('/admin/login')).text_, /name="identifier"/);
});

test('admin URL variants redirect to the right page instead of 404', async () => {
  const boss = new Client(); await boss.login('boss');
  const art = (await db.prepare('SELECT id FROM articles ORDER BY id LIMIT 1').get()).id;
  for (const [from, to] of [[`/admin/articles/${art}/edit`, `/admin/articles/${art}`], [`/admin/articles/${art}/view`, `/admin/articles/${art}`], [`/admin/articles/${art}/publish`, `/admin/articles/${art}`], ['/admin/categories/1/edit', '/admin/categories/1'], ['/admin/users/1/edit', '/admin/users/1']]) {
    const r = await boss.get(from);
    assert.equal(r.status, 302, from); assert.equal(r.headers.get('location'), to, from);
    assert.equal((await boss.get(to)).status, 200, to);
  }
});

test('CSRF: stale token from the same site is accepted; cross-site and header-less posts are refused', async () => {
  const ed = new Client(); await ed.login('ed');
  const host = new URL(base).origin;
  const post = (headers, body = {}) => ed.req('/admin/notifications/read-all', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
  assert.equal((await post({ origin: host }, { _csrf: 'stale-token' })).status, 302, 'same-origin with stale token');
  assert.equal((await post({ origin: host })).status, 302, 'same-origin without token');
  assert.equal((await post({ referer: host + '/admin' })).status, 302, 'same-origin via Referer');
  const evil = await post({ origin: 'https://evil.example' }, { _csrf: 'stale-token' });
  assert.equal(evil.status, 403); assert.match(evil.text_, /<html/); // friendly page, not raw text
  assert.equal((await post({}, {})).status, 403, 'no origin and no token');
  assert.equal((await post({ origin: 'https://evil.example' }, { _csrf: ed.csrf })).status, 302, 'a valid token always works');
});

test('logging in again from a browser that already has a session works', async () => {
  const c = new Client(); await c.login('adm');
  const other = new Client(); const f = await other.get('/admin/login');
  const lc2 = f.text_.match(/name="lc" value="([^"]+)"/)[1];
  other.jar.hm_sid = c.jar.hm_sid; // stale tab: the browser already holds a valid session cookie
  const r = await other.req('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: new URL(base).origin }, body: new URLSearchParams({ identifier: 'adm', password: PW, lc: lc2 }).toString() });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/admin');
  assert.equal((await other.get('/admin')).status, 200);
});
