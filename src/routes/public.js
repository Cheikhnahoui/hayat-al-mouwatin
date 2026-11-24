'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const content = require('../lib/content');
const ads = require('../lib/ads');
const comments = require('../lib/comments');
const { tr } = require('../i18n');
const { esc, hmac, clientIp, isHttpUrl } = require('../lib/util');
const { articlePath, categoryPath, authorPath, abs } = require('../lib/urls');
const { stripTags } = require('../lib/sanitize');
const { layout } = require('../views/public/layout');
const P = require('../views/public/pages');
const { parseCookies } = require('../lib/auth');

const router = express.Router();
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|monitor/i;
const isBot = (req) => BOT.test(req.get('user-agent') || '');
const PER_PAGE = 12;

function preferredLang(req) {
  const avail = settings.langs();
  const c = parseCookies(req).hm_lang;
  if (avail.includes(c)) return c;
  const al = String(req.get('accept-language') || '').toLowerCase();
  for (const part of al.split(',')) { const l = part.trim().slice(0, 2); if (avail.includes(l)) return l; }
  return avail.includes(settings.get('default_lang')) ? settings.get('default_lang') : avail[0];
}

router.get('/', (req, res) => res.redirect(302, '/' + preferredLang(req)));

// ---- non-localized endpoints ----
router.get('/ad/:id/click', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dest = id && !isBot(req) ? (await ads.click(id)) : ((await db.prepare('SELECT destination_url FROM advertisements WHERE id = ?').get(id)) || {}).destination_url;
  if (!dest || !isHttpUrl(dest)) return res.redirect('/');
  res.set('Referrer-Policy', 'no-referrer').redirect(302, dest);
});
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /ad/\nAllow: /\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
});
router.get('/sitemap.xml', async (req, res) => {
  const langs = settings.langs();
  const urls = [];
  const alt = (map) => Object.entries(map).map(([l, p]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${esc(abs(p))}"/>`).join('');
  for (const l of langs) urls.push({ loc: `/${l}`, alt: alt(Object.fromEntries(langs.map((x) => [x, `/${x}`]))), pr: '1.0' });
  const cats = (await db.prepare('SELECT id FROM categories WHERE is_active = 1').all());
  for (const c of cats) {
    const s = (await content.categorySlugs(c.id));
    const map = Object.fromEntries(langs.filter((l) => s[l]).map((l) => [l, categoryPath(l, s[l])]));
    for (const l of Object.keys(map)) urls.push({ loc: map[l], alt: alt(map), pr: '0.6' });
  }
  const arts = (await db.prepare(`SELECT a.id, a.updated_at FROM articles a WHERE ${content.PUBLISHED} ORDER BY a.published_at DESC LIMIT 5000`).all());
  for (const a of arts) {
    const av = (await content.availableLangs(a.id));
    const map = Object.fromEntries(langs.filter((l) => av[l]).map((l) => [l, articlePath(l, { id: a.id, slug: av[l] })]));
    for (const l of Object.keys(map)) urls.push({ loc: map[l], alt: alt(map), last: a.updated_at, pr: '0.8' });
  }
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls.map((u) => `<url><loc>${esc(abs(u.loc))}</loc>${u.last ? `<lastmod>${u.last.slice(0, 10)}</lastmod>` : ''}<priority>${u.pr}</priority>${u.alt}</url>`).join('')}</urlset>`);
});

// ---- localized site ----
const L = express.Router({ mergeParams: true });
router.use('/:lang', async (req, res, next) => {
  const lang = req.params.lang;
  if (!['ar', 'fr'].includes(lang)) return next('router');
  if (!settings.langs().includes(lang)) return res.redirect(302, '/' + settings.langs()[0]);
  const t = (k, v) => tr(lang, k, v);
  const base = '/' + lang;
  const ctx = {
    lang, t, path: req.path === '/' ? base : base + req.path.replace(/\/$/, ''), q: '',
    cats: (await content.categories(lang)), breaking: (await content.breaking(lang)),
    swap: (to) => (req.originalUrl.replace(/^\/(ar|fr)(?=\/|$|\?)/, '/' + to)),
  };
  // pick banner ads only for pages that show them
  ctx.adTop = req.path === '/' ? (await ads.pick('home_top', { isBot: isBot(req) })) : null;
  ctx.adFooter = (await ads.pick('footer', { isBot: isBot(req) }));
  req.ctx = ctx;
  res.cookie('hm_lang', lang, { maxAge: 365 * 864e5, sameSite: 'lax', secure: config.isProd, path: '/' });
  res.page = (page, status = 200) => res.status(status).type('html').send(layout(ctx, page));
  next();
}, L);

const intParam = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const page = (req) => Math.min(intParam(req.query.page, 1), 1000);

L.get('/', async (req, res) => {
  const { ctx } = req;
  const adsCtx = { sidebar: (await ads.pick('home_sidebar', { isBot: isBot(req) })), between: [(await ads.pick('home_between', { isBot: isBot(req) }))].filter(Boolean) };
  res.page({ body: (await P.home(ctx, adsCtx)), nav: 'home', alternates: { ar: '/ar', fr: '/fr' }, canonical: '/' + ctx.lang,
    jsonld: { '@context': 'https://schema.org', '@type': 'WebSite', name: ctx.lang === 'ar' ? settings.get('site_name_ar') : settings.get('site_name_fr'), url: abs('/' + ctx.lang), inLanguage: ctx.lang,
      potentialAction: { '@type': 'SearchAction', target: abs(`/${ctx.lang}/search?q={q}`), 'query-input': 'required name=q' } } });
});

L.get('/article/:slugid', async (req, res, next) => {
  const { ctx } = req, { lang, t } = ctx;
  const id = parseInt(req.params.slugid, 10);
  if (!id || !(await content.articleExists(id))) return next();
  const a = (await content.getArticle(id, lang));
  const av = (await content.availableLangs(id));
  if (!a) {
    const other = lang === 'ar' ? 'fr' : 'ar';
    if (!av[other]) return next();
    const alts = { [other]: articlePath(other, { id, slug: av[other] }) };
    return res.page({ title: t('not_available_title'), body: P.notAvailable(ctx, { id }, other, av[other]), noindex: true, alternates: alts, switchTo: alts[other] }, 200);
  }
  // canonical slug redirect
  const canonical = articlePath(lang, a);
  if (decodeURIComponent(req.path) !== decodeURIComponent(canonical.slice(lang.length + 1))) return res.redirect(301, canonical + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));

  if (!isBot(req)) (await content.countView(id, hmac(clientIp(req) + (req.get('user-agent') || ''))));
  const alternates = Object.fromEntries(Object.entries(av).filter(([l]) => settings.langs().includes(l)).map(([l, s]) => [l, articlePath(l, { id, slug: s })]));
  const other = lang === 'ar' ? 'fr' : 'ar';
  const flash = ['pending', 'published', 'err', 'rate', 'reported'].includes(req.query.c) ? req.query.c : '';
  const ts = Date.now();
  const adv = { inline: (await ads.pick('article_inline', { isBot: isBot(req) })), below: (await ads.pick('article_below', { isBot: isBot(req) })) };
  const tags = (await content.tagsFor(id, lang));
  const img = a.img_file ? `/uploads/${a.img_medium || a.img_file}` : undefined;
  const siteName = lang === 'ar' ? settings.get('site_name_ar') : settings.get('site_name_fr');
  const desc = a.seo_description || a.summary || stripTags(a.content).slice(0, 160);
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'NewsArticle', mainEntityOfPage: { '@type': 'WebPage', '@id': abs(canonical) },
    headline: (a.seo_title || a.title).slice(0, 110), description: desc, inLanguage: lang,
    image: [abs(img || settings.get('seo_default_image') || '/img/logo.png')],
    datePublished: a.published_at.replace(' ', 'T') + 'Z', dateModified: (a.updated_at || a.published_at).replace(' ', 'T') + 'Z',
    articleSection: a.cat_name, keywords: tags.map((x) => x.name).join(', ') || undefined,
    author: a.author ? [{ '@type': 'Person', name: a.author, ...(a.author_id ? { url: abs(authorPath(lang, a.author_id)) } : {}) }] : [{ '@type': 'Organization', name: siteName }],
    publisher: { '@type': 'Organization', name: siteName, logo: { '@type': 'ImageObject', url: abs(settings.get('logo')) } },
  };
  res.page({
    title: a.seo_title || a.title, description: desc, canonical, alternates, image: img, type: 'article', jsonld, nav: a.cat_slug,
    switchTo: alternates[other] || `/${other}/article/${id}`,
    extraHead: `<meta property="article:published_time" content="${esc(jsonld.datePublished)}"><meta property="article:section" content="${esc(a.cat_name)}">`,
    body: (await P.article(ctx, a, { tags, ads: adv, related: (await content.related(lang, a, 4)), latest: (await content.list(lang, { where: 'a.id <> @id', params: { id }, limit: 5 })),
      commentsList: (await comments.forArticle(id)), flash, formToken: `${ts}.${hmac('ft' + ts)}` })),
  });
});

L.post('/article/:id/comment', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res, next) => {
  const { lang } = req.ctx;
  const id = parseInt(req.params.id, 10);
  const av = id && (await content.availableLangs(id));
  if (!av || !av[lang]) return next();
  const back = articlePath(lang, { id, slug: av[lang] });
  const [ts, sig] = String(req.body.ft || '').split('.');
  const valid = ts && sig && hmac('ft' + ts) === sig && Date.now() - +ts < 6 * 3600e3;
  const r = valid
    ? (await comments.submit({ articleId: id, name: req.body.name, email: req.body.email, body: req.body.body, honeypot: req.body.website, formAge: (Date.now() - +ts) / 1000, ip: clientIp(req) }))
    : { error: 'invalid' };
  const flash = r.error ? (r.error === 'rate' ? 'rate' : 'err') : r.status === 'approved' ? 'published' : 'pending';
  res.redirect(303, `${back}?c=${flash}#comments`);
});
L.post('/comments/:id/report', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  (await comments.report(parseInt(req.params.id, 10)));
  const back = String(req.body.back || '');
  res.redirect(303, (back.startsWith(`/${req.ctx.lang}/article/`) ? back : `/${req.ctx.lang}`) + '?c=reported#comments');
});

L.get('/category/:slug', async (req, res, next) => {
  const { ctx } = req, { lang } = ctx;
  const cat = (await content.categoryBySlug(lang, req.params.slug));
  if (!cat) return next();
  const pg = page(req);
  const where = 'a.category_id = @c', params = { c: cat.id };
  const total = (await content.count(lang, { where, params }));
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const featured = pg === 1 ? (await content.list(lang, { where, params, limit: 1 }))[0] : null;
  const items = (await content.list(lang, { where: where + (featured ? ' AND a.id <> @f' : ''), params: { ...params, f: featured?.id }, limit: PER_PAGE, offset: (pg - 1) * PER_PAGE }));
  const slugs = (await content.categorySlugs(cat.id));
  const alternates = Object.fromEntries(settings.langs().filter((l) => slugs[l]).map((l) => [l, categoryPath(l, slugs[l])]));
  res.page({
    title: cat.seo_title || cat.name, description: cat.seo_description || cat.description, nav: cat.slug, alternates, canonical: categoryPath(lang, cat.slug) + (pg > 1 ? `?page=${pg}` : ''),
    body: P.listing(ctx, { head: P.categoryHead(ctx, cat, featured), items, pagerHtml: require('../views/public/components').pager(categoryPath(lang, cat.slug), pg, pages, ctx) }),
  });
});

L.get('/tag/:slug', async (req, res, next) => {
  const { ctx } = req, { lang, t } = ctx;
  const tag = (await content.tagBySlug(lang, req.params.slug));
  if (!tag) return next();
  const pg = page(req);
  const r = (await content.search(lang, { tag: tag.tag_id, page: pg, per: PER_PAGE }));
  res.page({ title: `#${tag.name}`, noindex: pg > 1, alternates: { [lang]: `/${lang}/tag/${encodeURIComponent(tag.slug)}` },
    body: P.listing(ctx, { head: `<div class="cat-hd"><h1>#${esc(tag.name)}</h1></div>`, items: r.items, pagerHtml: require('../views/public/components').pager(`/${lang}/tag/${encodeURIComponent(tag.slug)}`, pg, r.pages, ctx) }) });
});

L.get('/author/:id', async (req, res, next) => {
  const { ctx } = req, { lang } = ctx;
  const au = (await content.author(parseInt(req.params.id, 10)));
  if (!au) return next();
  const pg = page(req);
  const r = (await content.search(lang, { author: au.id, page: pg, per: PER_PAGE }));
  res.page({ title: lang === 'ar' ? au.name_ar || au.name_fr : au.name_fr || au.name_ar, nav: '', alternates: { ar: authorPath('ar', au.id), fr: authorPath('fr', au.id) },
    body: P.authorPage(ctx, au, r.items, require('../views/public/components').pager(authorPath(lang, au.id), pg, r.pages, ctx)) });
});

L.get('/search', async (req, res) => {
  const { ctx } = req, { lang, t } = ctx;
  const q = String(req.query.q || '').trim().slice(0, 100);
  const f = { q, category: intParam(req.query.category), from: String(req.query.from || ''), to: String(req.query.to || '') };
  ctx.q = q;
  const pg = page(req);
  const r = (await content.search(lang, { ...f, page: pg, per: PER_PAGE }));
  const qs = new URLSearchParams(Object.fromEntries(Object.entries({ q: f.q, category: f.category || '', from: f.from, to: f.to }).filter(([, v]) => v))).toString();
  res.page({ title: q ? `${t('results_for')}: ${q}` : t('search'), noindex: true,
    body: P.listing(ctx, { head: `<div class="sh" style="margin-top:20px"><h2>${esc(q ? `${t('results_for')}: ${q}` : t('search'))}${r.total ? ` (${r.total})` : ''}</h2></div>`, filters: P.searchFilters(ctx, f), items: r.items,
      pagerHtml: require('../views/public/components').pager(`/${lang}/search${qs ? '?' + qs : ''}`, pg, r.pages, ctx) }) });
});

L.get('/feed.xml', async (req, res) => {
  const { lang } = req.ctx;
  const items = (await content.list(lang, { limit: 30 }));
  const name = lang === 'ar' ? settings.get('site_name_ar') : settings.get('site_name_fr');
  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(name)}</title><link>${esc(abs('/' + lang))}</link><description>${esc(lang === 'ar' ? settings.get('description_ar') : settings.get('description_fr'))}</description><language>${lang}</language>${items.map((a) => `<item><title>${esc(a.title)}</title><link>${esc(abs(articlePath(lang, a)))}</link><guid>${esc(abs(articlePath(lang, a)))}</guid><pubDate>${new Date(a.published_at.replace(' ', 'T') + 'Z').toUTCString()}</pubDate><description>${esc(a.summary)}</description></item>`).join('')}</channel></rss>`);
});

// 404 inside a language
L.use((req, res) => res.page({ title: req.ctx.t('not_found'), body: P.notFound(req.ctx), noindex: true }, 404));

module.exports = router;
