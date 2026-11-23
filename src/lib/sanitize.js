'use strict';
const sanitizeHtml = require('sanitize-html');

const VIDEO_HOSTS = ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'];

const richOptions = {
  allowedTags: ['h2', 'h3', 'h4', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a', 'img', 'figure', 'figcaption', 'hr', 'div', 'iframe', 'span'],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    iframe: ['src', 'width', 'height', 'allowfullscreen', 'title', 'loading', 'referrerpolicy'],
    div: ['class'], figure: ['class'], blockquote: ['class'], p: ['class'], span: ['class'],
  },
  allowedClasses: { div: ['video', 'ql-align-center'], figure: ['img'], p: ['lead'], blockquote: ['quote'], span: [] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowedIframeHostnames: VIDEO_HOSTS,
  allowProtocolRelative: false,
  transformTags: {
    a: (tag, attribs) => {
      const href = attribs.href || '';
      const ext = /^https?:\/\//i.test(href);
      return { tagName: 'a', attribs: { ...attribs, ...(ext ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {}) } };
    },
    img: (tag, attribs) => ({ tagName: 'img', attribs: { ...attribs, loading: 'lazy' } }),
    iframe: (tag, attribs) => ({ tagName: 'iframe', attribs: { ...attribs, loading: 'lazy', referrerpolicy: 'strict-origin-when-cross-origin' } }),
  },
  // images must come from our own uploads or https
  exclusiveFilter: (f) => f.tag === 'img' && !/^(\/uploads\/|https:\/\/)/i.test(f.attribs.src || ''),
};

const rich = (html) => sanitizeHtml(String(html || ''), richOptions);
const text = (s) => sanitizeHtml(String(s ?? ''), { allowedTags: [], allowedAttributes: {} }).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
const stripTags = (html) => text(sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} })).replace(/\s+/g, ' ');

// Convert a YouTube / Vimeo watch URL to an embed URL (or null)
function videoEmbedUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') return 'https://www.youtube.com/embed/' + u.pathname.slice(1).split('/')[0];
    if (h === 'youtube.com' || h === 'm.youtube.com') {
      if (u.pathname === '/watch' && u.searchParams.get('v')) return 'https://www.youtube.com/embed/' + u.searchParams.get('v');
      const m = u.pathname.match(/^\/(embed|shorts|live)\/([\w-]{6,20})/);
      if (m) return 'https://www.youtube.com/embed/' + m[2];
    }
    if (h === 'vimeo.com') { const m = u.pathname.match(/^\/(\d+)/); if (m) return 'https://player.vimeo.com/video/' + m[1]; }
    if (h === 'player.vimeo.com') return u.href;
  } catch { /* fallthrough */ }
  return null;
}

module.exports = { rich, text, stripTags, videoEmbedUrl };
