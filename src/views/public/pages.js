'use strict';
const { esc, fmtDate, num } = require('../../lib/util');
const settings = require('../../lib/settings');
const content = require('../../lib/content');
const comments = require('../../lib/comments');
const { articlePath, categoryPath, tagPath, authorPath, abs } = require('../../lib/urls');
const { videoEmbedUrl } = require('../../lib/sanitize');
const C = require('./components');

// ---------------- HOME ----------------
function home(ctx, ads) {
  const { lang, t } = ctx;
  const order = settings.get('home_sections').split(',').map((s) => s.trim()).filter(Boolean);
  const on = (k) => order.includes(k);

  const main = content.list(lang, { where: "a.featured_slot = 'main'", limit: 1 });
  const sec = content.list(lang, { where: "a.featured_slot = 'secondary'", limit: 2, order: 'a.updated_at DESC' });
  let used = new Set([...main, ...sec].map((a) => a.id));
  const fill = (n, exclude) => content.list(lang, { where: `a.type = 'news' ${exclude.size ? `AND a.id NOT IN (${[...exclude].join(',')})` : ''}`, limit: n });
  let heroMain = main[0];
  let heroSec = sec;
  if (!heroMain) { heroMain = fill(1, used)[0]; if (heroMain) used.add(heroMain.id); }
  if (heroSec.length < 2) { const extra = fill(2 - heroSec.length, used); extra.forEach((a) => used.add(a.id)); heroSec = heroSec.concat(extra); }

  const latest = content.list(lang, { where: `a.type <> 'opinion' ${used.size ? `AND a.id NOT IN (${[...used].join(',')})` : ''}`, limit: 8 });
  const popular = content.mostRead(lang, 5);
  const trending = content.trending(lang, 5);

  const renders = {
    hero: () => (heroMain ? `<div class="w"><div class="hero">${C.hero(ctx, heroMain, true)}<div class="side">${heroSec.map((a) => C.heroSmall(ctx, a)).join('')}</div></div></div>` : ''),
    latest: () => {
      const aside = `<aside class="sidebar-stack">${on('popular') && popular.length ? `<div class="box">${C.sectionHead(t('most_read'))}${C.popList(ctx, popular)}</div>` : ''}${on('trending') && trending.length ? `<div class="box">${C.sectionHead(t('trending'))}${C.popList(ctx, trending)}</div>` : ''}${C.adSlot(ctx, ads.sidebar, 'side')}</aside>`;
      return `<div class="w"><div class="cols"><section>${C.sectionHead(t('latest'))}${latest.map((a) => C.row(ctx, a)).join('') || `<p class="empty">${esc(t('no_articles'))}</p>`}</section>${aside}</div></div>`;
    },
    categories: () => {
      let html = '', i = 0;
      for (const c of ctx.cats.filter((x) => x.show_on_home)) {
        const l = content.list(lang, { where: 'a.category_id = @c', params: { c: c.id }, limit: 4 });
        if (!l.length) continue;
        html += `<div class="w"><section class="sec">${C.sectionHead(c.name, categoryPath(lang, c.slug), t('all_categories'))}<div class="grid">${l.map((a) => C.card(ctx, a)).join('')}</div></section></div>`;
        if (++i % 3 === 0 && ads.between[(i / 3 - 1) % Math.max(ads.between.length, 1)]) html += `<div class="w">${C.adSlot(ctx, ads.between[(i / 3 - 1) % ads.between.length])}</div>`;
      }
      return html;
    },
    interviews: () => typeSection(ctx, 'interview', t('interviews')),
    investigations: () => typeSection(ctx, 'investigation', t('investigations')),
    opinions: () => {
      const l = content.list(lang, { where: "a.type = 'opinion'", limit: 6 });
      return l.length ? `<div class="w"><section class="sec">${C.sectionHead(t('opinions'))}<div class="op">${l.map((a) => `<a href="${articlePath(lang, a)}"><h3>${esc(a.title)}</h3><span class="meta">${esc(a.author)} · ${fmtDate(a.published_at, lang)}</span></a>`).join('')}</div></section></div>` : '';
    },
    videos: () => {
      const l = content.list(lang, { where: "a.type = 'video'", limit: 3 });
      return l.length ? `<div class="w"><section class="sec">${C.sectionHead(t('videos'))}<div class="vids">${l.map((a) => C.card(ctx, a)).join('')}</div></section></div>` : '';
    },
  };
  const body = order.filter((k) => renders[k]).map((k) => renders[k]()).join('');
  return body || `<div class="w"><p class="empty">${esc(t('no_articles'))}</p></div>`;
}
function typeSection(ctx, type, title) {
  const l = content.list(ctx.lang, { where: 'a.type = @ty', params: { ty: type }, limit: 4 });
  return l.length ? `<div class="w"><section class="sec">${C.sectionHead(title)}<div class="grid">${l.map((a) => C.card(ctx, a)).join('')}</div></section></div>` : '';
}

// ---------------- ARTICLE ----------------
function injectInlineAd(html, adHtml) {
  if (!adHtml) return html;
  let idx = -1, n = 0;
  const re = /<\/p>/gi; let m;
  while ((m = re.exec(html))) { if (++n === 2) { idx = m.index + 4; break; } }
  return idx < 0 ? html + adHtml : html.slice(0, idx) + adHtml + html.slice(idx);
}
function article(ctx, a, { tags, related, latest, ads, commentsList, flash, formToken }) {
  const { lang, t } = ctx;
  const url = abs(articlePath(lang, a));
  const u = encodeURIComponent(url), ti = encodeURIComponent(a.title);
  const embed = a.type === 'video' && a.video_url ? videoEmbedUrl(a.video_url) : null;
  const cap = (lang === 'ar' ? a.caption_ar : a.caption_fr);
  const auth = content.author(a.author_id);
  const showComments = settings.bool('comments_enabled') && a.comments_enabled;
  return `<div class="w"><article class="art">
<span class="tag"><a href="${categoryPath(lang, a.cat_slug)}">${esc(a.cat_name)}</a></span>${C.typeTag(ctx, a)}
<h1>${esc(a.title)}</h1>
${a.summary ? `<p class="lead">${esc(a.summary)}</p>` : ''}
<div class="meta">${a.author ? `${esc(t('by'))} ${auth ? `<a href="${authorPath(lang, auth.id)}">${esc(a.author)}</a>` : esc(a.author)} · ` : ''}<time datetime="${esc(a.published_at)}Z">${fmtDate(a.published_at, lang, true)}</time> · ${num(a.view_count, lang)} ${esc(t('views'))} · ${content.readingMinutes(a.content)} ${esc(t('min_read'))}</div>
${embed ? `<div class="vid"><iframe src="${esc(embed)}" title="${esc(a.title)}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>` : `<figure style="margin:0">${C.pic(a, { eager: true, size: 'large', sizes: '(max-width:860px) 100vw, 820px' }).replace('class="im"', 'class="im" style="aspect-ratio:16/9;border-radius:6px;margin-block:16px"')}${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>`}
<div class="body">${injectInlineAd(a.content, C.adSlot(ctx, ads.inline))}</div>
${tags.length ? `<div class="chips" aria-label="${esc(t('tags'))}">${tags.map((x) => `<a href="${tagPath(lang, x.slug)}">#${esc(x.name)}</a>`).join('')}</div>` : ''}
<div class="sh2"><b>${esc(t('share'))}:</b>
<a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=${ti}%20${u}">${esc(t('whatsapp'))}</a>
<a class="btn fb" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${u}">${esc(t('facebook'))}</a>
<a class="btn gh" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?url=${u}&text=${ti}">${esc(t('x'))}</a>
<a class="btn gh" target="_blank" rel="noopener" href="https://t.me/share/url?url=${u}&text=${ti}">${esc(t('telegram'))}</a>
<a class="btn gh" href="${esc(url)}" data-copy="${esc(url)}" data-done="${esc(t('copied'))}">${esc(t('copy_link'))}</a></div>
${auth ? `<div class="auth-box"><div class="avatar">${auth.avatar ? `<img src="/uploads/${esc(auth.avatar)}" alt="">` : esc((lang === 'ar' ? auth.name_ar : auth.name_fr || auth.name_ar).slice(0, 1))}</div><div><b><a href="${authorPath(lang, auth.id)}">${esc(lang === 'ar' ? auth.name_ar || auth.name_fr : auth.name_fr || auth.name_ar)}</a></b><div class="meta">${esc(t('articles_by'))} →</div></div></div>` : ''}
${C.adSlot(ctx, ads.below)}
${showComments ? commentsBlock(ctx, a, commentsList, flash, formToken) : (a.comments_enabled ? '' : `<p class="meta">${esc(t('comments_closed'))}</p>`)}
${related.length ? `<div class="sh"><h2>${esc(t('related'))}</h2></div><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">${related.map((x) => C.card(ctx, x)).join('')}</div>` : ''}
${latest.length ? `<div class="sh" style="margin-top:30px"><h2>${esc(t('latest_articles'))}</h2></div>${latest.map((x) => C.row(ctx, x)).join('')}` : ''}
</article></div>`;
}
function commentsBlock(ctx, a, list, flash, formToken) {
  const { lang, t } = ctx;
  const fl = flash ? `<div class="flash ${flash === 'err' || flash === 'rate' ? 'err' : ''}" role="status">${esc(t(flash === 'pending' ? 'comment_pending' : flash === 'published' ? 'comment_published' : flash === 'rate' ? 'comment_rate' : flash === 'reported' ? 'reported' : 'comment_error'))}</div>` : '';
  return `<section class="cm" id="comments"><div class="sh"><h2>${esc(t('comments'))} (${list.length})</h2></div>${fl}
${list.map((c) => `<div class="item"><b>${esc(c.author_name)}</b> <span class="meta">· ${fmtDate(c.created_at, lang, true)}</span><p style="margin:4px 0">${esc(c.body).replace(/\n/g, '<br>')}</p>
<form method="post" action="/${lang}/comments/${c.id}/report" style="display:inline"><input type="hidden" name="back" value="${esc(articlePath(lang, a))}"><button class="rp">${esc(t('report'))}</button></form></div>`).join('') || `<p class="meta">${esc(t('no_comments'))}</p>`}
<form method="post" action="/${lang}/article/${a.id}/comment"><h3>${esc(t('leave_comment'))}</h3>
<input type="hidden" name="ft" value="${esc(formToken)}">
<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
<label>${esc(t('your_name'))}<input name="name" required minlength="2" maxlength="60"></label>
<label>${esc(t('your_email'))}<input name="email" type="email" maxlength="120"></label>
<label>${esc(t('your_comment'))}<textarea name="body" rows="4" required minlength="3" maxlength="2000"></textarea></label>
<button class="btn">${esc(t('send_comment'))}</button></form></section>`;
}

// ---------------- LISTING (category / tag / author / search) ----------------
function listing(ctx, { head, items, pagerHtml, filters = '' }) {
  return `<div class="w">${head || ''}${filters}${items.length ? `<div class="grid">${items.map((a) => C.card(ctx, a)).join('')}</div>` : `<p class="empty">${esc(ctx.t('no_results'))}</p>`}${pagerHtml || ''}</div>`;
}
function categoryHead(ctx, cat, featured) {
  return `<div class="cat-hd"><h1>${esc(cat.name)}</h1>${cat.description ? `<p>${esc(cat.description)}</p>` : ''}</div>${featured ? `<div class="hero" style="grid-template-columns:1fr">${C.hero(ctx, featured, true)}</div>` : ''}`;
}
function searchFilters(ctx, f) {
  const { lang, t } = ctx;
  return `<form class="filters" method="get" action="/${lang}/search" role="search">
<label>${esc(t('search'))}<input name="q" value="${esc(f.q)}" maxlength="100"></label>
<label>${esc(t('category'))}<select name="category"><option value="">${esc(t('all_categories'))}</option>${ctx.cats.map((c) => `<option value="${c.id}" ${+f.category === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
<label>${esc(t('from_date'))}<input type="date" name="from" value="${esc(f.from)}"></label>
<label>${esc(t('to_date'))}<input type="date" name="to" value="${esc(f.to)}"></label>
<button class="btn">${esc(t('filter'))}</button></form>`;
}

function authorPage(ctx, au, items, pagerHtml) {
  const { lang, t } = ctx;
  const name = lang === 'ar' ? au.name_ar || au.name_fr : au.name_fr || au.name_ar;
  const bio = lang === 'ar' ? au.bio_ar || au.bio_fr : au.bio_fr || au.bio_ar;
  const head = `<div class="cat-hd" style="display:flex;gap:16px;align-items:center"><div class="avatar" style="width:72px;height:72px;font-size:28px">${au.avatar ? `<img src="/uploads/${esc(au.avatar)}" alt="">` : esc(name.slice(0, 1))}</div><div><h1>${esc(name)}</h1><p>${esc(t('journalist'))}</p>${bio ? `<p>${esc(bio)}</p>` : ''}</div></div><div class="sh"><h2>${esc(t('articles_by'))}</h2></div>`;
  return listing(ctx, { head, items, pagerHtml });
}

function notAvailable(ctx, a, otherLang, otherSlug) {
  const { t } = ctx;
  return `<div class="w"><div class="notice" role="alert" style="max-width:720px;margin:40px auto"><h1 style="margin:0 0 8px;font-size:22px">${esc(t('not_available_title'))}</h1><p>${esc(t('not_available_body'))}</p><a class="btn" href="/${otherLang}/article/${a.id}-${encodeURIComponent(otherSlug)}" hreflang="${otherLang}">${esc(t('read_in'))}</a> <a class="btn gh" href="/${ctx.lang}">${esc(t('back_home'))}</a></div></div>`;
}
const notFound = (ctx) => `<div class="w"><div class="empty"><h1>404</h1><h2>${esc(ctx.t('not_found'))}</h2><p>${esc(ctx.t('not_found_body'))}</p><a class="btn" href="/${ctx.lang}">${esc(ctx.t('back_home'))}</a></div></div>`;
const serverError = (ctx) => `<div class="w"><div class="empty"><h1>500</h1><h2>${esc(ctx.t('error'))}</h2><a class="btn" href="/${ctx.lang}">${esc(ctx.t('back_home'))}</a></div></div>`;

module.exports = { home, article, listing, categoryHead, searchFilters, authorPage, notAvailable, notFound, serverError };
