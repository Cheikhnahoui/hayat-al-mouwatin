'use strict';
const config = require('../../config');
const settings = require('../../lib/settings');
const { esc, fmtDate } = require('../../lib/util');
const { abs } = require('../../lib/urls');
const { adSlot } = require('./components');

const SOC = [['facebook', 'Facebook'], ['x', 'X'], ['youtube', 'YouTube'], ['instagram', 'Instagram'], ['whatsapp', 'WhatsApp']];
const safeColor = (c, d) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : d);

/**
 * page: { title, description, path (current path, language-prefixed), alternates:{ar,fr} (paths), switchTo, canonical, image, type, jsonld, noindex, nav (active category slug), body, extraHead }
 */
function layout(ctx, page) {
  const { lang, t } = ctx;
  const s = settings.all();
  const siteName = lang === 'ar' ? s.site_name_ar : s.site_name_fr;
  const other = lang === 'ar' ? 'fr' : 'ar';
  const langs = settings.langs();
  const title = page.title ? `${page.title} – ${siteName}` : `${siteName} – ${t('site_desc_suffix')}`;
  const desc = page.description || (lang === 'ar' ? s.description_ar : s.description_fr);
  const canonical = page.canonical ? abs(page.canonical) : abs(ctx.path);
  const image = abs(page.image || s.seo_default_image || '/img/logo.png');
  const alts = page.alternates || { ar: ctx.swap('ar'), fr: ctx.swap('fr') };
  const hreflang = langs.filter((l) => alts[l]).map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(abs(alts[l]))}">`).join('')
    + (alts[settings.get('default_lang')] ? `<link rel="alternate" hreflang="x-default" href="${esc(abs(alts[settings.get('default_lang')]))}">` : '');
  const switchHref = page.switchTo || alts[other] || `/${other}`;
  const social = SOC.filter(([k]) => s['social_' + k]).map(([k, n]) => `<a class="soc" href="${esc(s['social_' + k])}" target="_blank" rel="noopener nofollow me">${n}</a>`);

  const nav = [`<a href="/${lang}" class="${page.nav === 'home' ? 'on' : ''}">${esc(t('home'))}</a>`]
    .concat(ctx.cats.map((c) => `<a href="/${lang}/category/${encodeURIComponent(c.slug)}" class="${page.nav === c.slug ? 'on' : ''}">${esc(c.name)}</a>`)).join('');
  const brk = ctx.breaking.length
    ? `<div class="brk" role="region" aria-label="${esc(t('breaking'))}"><div class="w"><em>${esc(t('breaking'))}</em><div class="t"><span>${ctx.breaking.map((a) => `<a href="/${lang}/article/${a.id}-${encodeURIComponent(a.slug)}">${esc(a.title)}</a>`).join('   ◆   ')}</span></div></div></div>` : '';

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${t('dir')}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${page.noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow,max-image-preview:large">'}
<link rel="canonical" href="${esc(canonical)}">
${hreflang}
<meta property="og:site_name" content="${esc(siteName)}"><meta property="og:title" content="${esc(page.title || siteName)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="${page.type || 'website'}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${esc(image)}"><meta property="og:locale" content="${t('locale')}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(page.title || siteName)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
${page.extraHead || ''}
<link rel="icon" href="${esc(s.favicon)}">
<link rel="alternate" type="application/rss+xml" title="${esc(siteName)}" href="/${lang}/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/site.css?v=1">
<style>:root{--red:${safeColor(s.color_primary, '#8b1220')};--red2:${safeColor(s.color_primary_dark, '#6a0d18')}}</style>
${page.jsonld ? `<script type="application/ld+json">${JSON.stringify(page.jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head><body>
<a class="skip" href="#main">${esc(t('skip'))}</a>
<div class="top"><div class="w"><span>${fmtDate(new Date().toISOString().slice(0, 19).replace('T', ' '), lang)}</span><span class="acts">${social.join('')}${langs.length > 1 ? `<a class="langbtn" href="${esc(switchHref)}" hreflang="${other}" lang="${other}">${esc(t('switch_lang'))}</a>` : ''}</span></div></div>
<header class="hd"><div class="w"><a class="logo" href="/${lang}"><img class="mk" alt="" src="${esc(s.logo)}" width="60" height="60"><span><b>${esc(siteName)}</b><small>${esc(lang === 'ar' ? s.site_name_fr.toUpperCase() : s.site_name_ar)}</small></span></a>
<button class="menu-btn" type="button" aria-expanded="false" aria-controls="mainnav" data-menu>☰ ${esc(t('menu'))}</button>
<form class="sr" action="/${lang}/search" method="get" role="search"><input name="q" type="search" placeholder="${esc(t('search_ph'))}" aria-label="${esc(t('search'))}" value="${esc(ctx.q || '')}" maxlength="100"><button aria-label="${esc(t('search'))}">⌕</button></form></div></header>
<nav id="mainnav" aria-label="main"><div class="w">${nav}</div></nav>
${brk}
${ctx.adTop ? `<div class="w">${adSlot(ctx, ctx.adTop)}</div>` : ''}
<main id="main">${page.body}</main>
<footer><div class="w"><div><img class="mk" alt="" src="${esc(s.logo)}" width="64" height="64" style="margin-bottom:8px"><h4>${esc(siteName)}</h4><p>${esc(lang === 'ar' ? s.description_ar : s.description_fr)}</p></div>
<div><h4>${esc(t('links'))}</h4>${ctx.cats.slice(0, 5).map((c) => `<a href="/${lang}/category/${encodeURIComponent(c.slug)}">${esc(c.name)}</a>`).join('')}</div>
<div><h4>${esc(t('contact'))}</h4>${s.contact_email ? `<a href="mailto:${esc(s.contact_email)}">${esc(s.contact_email)}</a>` : ''}${s.phone ? `<a href="tel:${esc(s.phone.replace(/\s/g, ''))}">${esc(s.phone)}</a>` : ''}<h4 style="margin-top:12px">${esc(t('follow'))}</h4><div class="soc-list">${SOC.filter(([k]) => s['social_' + k]).map(([k, n]) => `<a href="${esc(s['social_' + k])}" target="_blank" rel="noopener nofollow me">${n}</a>`).join('')}</div></div>
${ctx.adFooter ? `<div style="grid-column:1/-1">${adSlot(ctx, ctx.adFooter)}</div>` : ''}
<small>${esc(t('rights', { y: new Date().getUTCFullYear(), name: siteName }))}</small></div></footer>
<script src="/js/site.js" defer></script>
</body></html>`;
}

module.exports = { layout };
