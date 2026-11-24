'use strict';
const { esc, fmtDate, num } = require('../../lib/util');
const { articlePath, categoryPath } = require('../../lib/urls');

// Image or generated placeholder (same look as the original prototype)
function pic(a, { eager = false, sizes = '(max-width:860px) 100vw, 400px', size = 'thumb' } = {}) {
  if (a.img_file) {
    const f = a.img_file;
    const set = [a.img_thumb && `/uploads/${a.img_thumb} 400w`, a.img_medium && `/uploads/${a.img_medium} 900w`, `/uploads/${f} 2000w`].filter(Boolean).join(', ');
    const src = size === 'large' ? f : (a.img_medium || f);
    return `<div class="im"><img src="/uploads/${esc(src)}" srcset="${esc(set)}" sizes="${sizes}" alt="${esc(a.img_alt || '')}" ${a.img_w ? `width="${a.img_w}" height="${a.img_h}"` : ''} ${eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'}></div>`;
  }
  const h = a.cat_hue || 0, n = [...String(a.id)].reduce((s, x) => s + x.charCodeAt(0), 0);
  return `<div class="im"><svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" role="img" aria-label=""><defs><linearGradient id="g${a.id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},55%,30%)"/><stop offset="1" stop-color="hsl(${(h + 30) % 360},60%,12%)"/></linearGradient></defs><rect width="160" height="100" fill="url(#g${a.id})"/><circle cx="${30 + n % 100}" cy="${22 + n % 20}" r="${14 + n % 10}" fill="hsl(${h},80%,70%)" opacity=".55"/><path d="M0 78 Q${30 + n % 30} ${50 + n % 12} 80 72 T160 ${60 + n % 15} V100 H0Z" fill="hsl(${h},50%,18%)" opacity=".85"/><path d="M0 90 Q50 ${70 + n % 12} 100 86 T160 88 V100 H0Z" fill="hsl(${h},45%,10%)"/></svg></div>`;
}

const typeTag = (ctx, a) => (a.type && a.type !== 'news' ? `<span class="tag type">${esc(ctx.t(a.type))}</span>` : '');
const link = (ctx, a) => articlePath(ctx.lang, a);

const card = (ctx, a) => `<a class="c" href="${link(ctx, a)}">${pic(a)}<div class="b"><span class="tag">${esc(a.cat_name)}</span>${typeTag(ctx, a)}<h3>${esc(a.title)}</h3><span class="meta">${fmtDate(a.published_at, ctx.lang)}</span></div></a>`;
const row = (ctx, a) => `<a class="row" href="${link(ctx, a)}">${pic(a)}<div><h4>${esc(a.title)}</h4><span class="meta">${esc(a.cat_name)} · ${fmtDate(a.published_at, ctx.lang)}</span></div></a>`;
const hero = (ctx, a, eager = false) => `<a class="big" href="${link(ctx, a)}">${pic(a, { eager, size: 'large', sizes: '(max-width:860px) 100vw, 780px' })}<div class="cap"><span class="tag">${esc(a.cat_name)}</span><h2>${esc(a.title)}</h2><span class="meta">${esc(a.author)}${a.author ? ' · ' : ''}${fmtDate(a.published_at, ctx.lang)}</span></div></a>`;
const heroSmall = (ctx, a) => `<a class="big" href="${link(ctx, a)}">${pic(a)}<div class="cap"><span class="tag">${esc(a.cat_name)}</span><h3>${esc(a.title)}</h3></div></a>`;
const sectionHead = (title, href, more) => `<div class="sh"><h2>${esc(title)}</h2>${href ? `<a class="more" href="${href}">${esc(more)} ›</a>` : ''}</div>`;
const popList = (ctx, items) => `<div class="pop">${items.map((a) => `<a href="${link(ctx, a)}"><span>${esc(a.title)}</span></a>`).join('')}</div>`;

function adSlot(ctx, ad, cls = '') {
  if (!ad) return '';
  const img = `/uploads/${esc(ad.medium || ad.file)}`;
  return `<div class="adwrap ${cls}"><small>${esc(ctx.t('sponsored'))}</small><a class="adimg" href="/ad/${ad.id}/click" target="_blank" rel="sponsored noopener nofollow"><img src="${img}" alt="${esc(ad.title)}" loading="lazy"></a></div>`;
}

function pager(base, page, pages, ctx) {
  if (pages <= 1) return '';
  const u = (p) => `${base}${base.includes('?') ? '&' : '?'}page=${p}`;
  const items = [];
  items.push(page > 1 ? `<a href="${u(page - 1)}" rel="prev">‹ ${esc(ctx.t('prev'))}</a>` : `<span class="dis">‹ ${esc(ctx.t('prev'))}</span>`);
  const win = new Set([1, pages, page, page - 1, page + 1, page - 2, page + 2].filter((p) => p >= 1 && p <= pages));
  let last = 0;
  for (const p of [...win].sort((a, b) => a - b)) {
    if (p - last > 1) items.push('<span>…</span>');
    items.push(p === page ? `<span class="cur" aria-current="page">${p}</span>` : `<a href="${u(p)}">${p}</a>`);
    last = p;
  }
  items.push(page < pages ? `<a href="${u(page + 1)}" rel="next">${esc(ctx.t('next'))} ›</a>` : `<span class="dis">${esc(ctx.t('next'))} ›</span>`);
  return `<nav class="pager" aria-label="pagination">${items.join('')}</nav>`;
}

module.exports = { pic, card, row, hero, heroSmall, sectionHead, popList, adSlot, pager, typeTag, num };
