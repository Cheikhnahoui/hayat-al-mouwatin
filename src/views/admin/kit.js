'use strict';
const { esc, fmtDate } = require('../../lib/util');
const settings = require('../../lib/settings');

const MSG = {
  saved: ['تم الحفظ', 'Enregistré'], deleted: ['تم الحذف', 'Supprimé'], done: ['تمت العملية', 'Opération effectuée'],
  submitted: ['أُرسل المقال للمراجعة', 'Article soumis pour relecture'], approved: ['تمت الموافقة', 'Article approuvé'], rejected: ['تم رفض المقال', 'Article refusé'],
  published: ['تم النشر', 'Publié'], scheduled: ['تمت الجدولة', 'Programmé'], unpublished: ['أُلغي النشر', 'Dépublié'], archived: ['تمت الأرشفة', 'Archivé'], restored: ['تمت الاستعادة', 'Restauré'],
  pw_changed: ['تم تغيير كلمة المرور', 'Mot de passe modifié'], uploaded: ['تم الرفع', 'Téléversé'],
};
const ERR = {
  forbidden: ['ليست لديك صلاحية لهذا الإجراء', 'Vous n’avez pas la permission'], invalid: ['بيانات غير صالحة، راجع الحقول', 'Données invalides, vérifiez les champs'],
  title: ['العنوان مطلوب في كل لغة مستعملة', 'Le titre est obligatoire pour chaque langue utilisée'], empty: ['أدخل محتوى بلغة واحدة على الأقل', 'Renseignez au moins une langue'],
  category: ['التصنيف غير صالح', 'Catégorie invalide'], image: ['الصورة غير صالحة', 'Image invalide'], video: ['رابط الفيديو غير مدعوم (يوتيوب أو فيميو)', 'Lien vidéo non pris en charge (YouTube ou Vimeo)'],
  no_content: ['لا يمكن النشر بدون محتوى', 'Publication impossible sans contenu'], state: ['حالة المقال لا تسمح بهذا الإجراء', 'L’état de l’article ne permet pas cette action'],
  future: ['اختر تاريخاً مستقبلياً', 'Choisissez une date future'], short: ['كلمة المرور قصيرة (10 أحرف على الأقل)', 'Mot de passe trop court (10 caractères minimum)'],
  weak: ['كلمة المرور ضعيفة: أضف أحرفاً وأرقاماً', 'Mot de passe faible : ajoutez lettres et chiffres'], exists: ['القيمة موجودة مسبقاً', 'Cette valeur existe déjà'],
  unsupported: ['نوع الملف غير مدعوم', 'Type de fichier non pris en charge'], too_large: ['الملف كبير جداً', 'Fichier trop volumineux'], wrong_password: ['كلمة المرور الحالية خاطئة', 'Mot de passe actuel incorrect'],
  self: ['لا يمكنك تنفيذ هذا الإجراء على حسابك', 'Action impossible sur votre propre compte'], last_super: ['لا يمكن إزالة آخر مدير عام', 'Impossible de retirer le dernier super administrateur'], in_use: ['العنصر مستعمل ولا يمكن حذفه', 'Élément utilisé, suppression impossible'],
};

const NAV = [
  ['dashboard', '/admin', '▦', ['لوحة المعلومات', 'Tableau de bord'], null],
  ['articles', '/admin/articles', '✎', ['المقالات', 'Articles'], ['articles.create', 'articles.edit_own', 'articles.edit_any', 'articles.review']],
  ['categories', '/admin/categories', '☰', ['التصنيفات', 'Catégories'], ['categories.manage']],
  ['tags', '/admin/tags', '#', ['الوسوم', 'Tags'], ['tags.manage']],
  ['media', '/admin/media', '▣', ['الوسائط', 'Médias'], ['media.upload', 'media.manage']],
  ['comments', '/admin/comments', '✉', ['التعليقات', 'Commentaires'], ['comments.moderate']],
  ['ads', '/admin/ads', '◎', ['الإعلانات', 'Publicités'], ['ads.manage', 'ads.stats']],
  ['users', '/admin/users', '☻', ['المستخدمون', 'Utilisateurs'], ['users.view', 'users.manage', 'journalists.manage']],
  ['analytics', '/admin/analytics', '↗', ['الإحصاءات', 'Statistiques'], ['analytics.view']],
  ['audit', '/admin/audit', '⌛', ['سجل العمليات', 'Journal d’audit'], ['audit.view']],
  ['settings', '/admin/settings', '⚙', ['الإعدادات', 'Paramètres'], ['settings.manage']],
];

function ctxFor(req) {
  const lang = req.user ? req.user.ui_lang : (req.cookies_lang || 'ar');
  const L = (ar, fr) => (lang === 'ar' ? ar : fr);
  return { lang, L, req, csrf: req.csrf || '', can: req.can, user: req.user };
}
const csrfField = (c) => `<input type="hidden" name="_csrf" value="${esc(c.csrf)}">`;
const postForm = (c, action, inner, { cls = '', confirm = '' } = {}) => `<form method="post" action="${esc(action)}" class="inline ${cls}" ${confirm ? `data-confirm="${esc(confirm)}"` : ''}>${csrfField(c)}${inner}</form>`;
const btn = (label, cls = 'btn') => `<button class="${cls}">${esc(label)}</button>`;

function shell(c, { title, active, body, back }) {
  const { L, lang, user } = c;
  const unread = c.req.unread || 0; // counted once per request in routes/admin/index.js (db calls are async)
  const s = settings.all();
  const m = c.req.query.m, e = c.req.query.e;
  const flash = (m && MSG[m] ? `<div class="flash" role="status">${esc(L(...MSG[m]))}</div>` : '') + (e ? `<div class="flash err" role="alert">${esc(ERR[e] ? L(...ERR[e]) : L(...ERR.invalid))}</div>` : '');
  const nav = NAV.filter(([, , , , perms]) => !perms || perms.some((p) => c.can(p)))
    .map(([k, href, ic, lbl]) => `<a href="${href}" class="${active === k ? 'on' : ''}"><span class="ic" aria-hidden="true">${ic}</span>${esc(L(...lbl))}</a>`).join('');
  return `<!DOCTYPE html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} – ${esc(L('لوحة التحكم', 'Administration'))}</title>
<link rel="icon" href="${esc(s.favicon)}"><link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/site.css?v=1"><link rel="stylesheet" href="/css/admin.css?v=1">
<style>:root{--red:${/^#[0-9a-f]{6}$/i.test(s.color_primary) ? s.color_primary : '#8b1220'};--red2:${/^#[0-9a-f]{6}$/i.test(s.color_primary_dark) ? s.color_primary_dark : '#6a0d18'}}</style></head>
<body class="adm" data-csrf="${esc(c.csrf)}" data-lang="${lang}">
<header class="ahd"><button class="menu-btn" type="button" data-asb aria-label="menu">☰</button><a class="logo" href="/admin"><img class="mk" src="${esc(s.logo)}" alt="" width="36" height="36"><b>${esc(L(s.site_name_ar, s.site_name_fr))}</b></a>
<span class="sp"></span>
<a class="notif" href="/admin/notifications" aria-label="${esc(L('الإشعارات', 'Notifications'))}">🔔${unread ? `<i>${unread}</i>` : ''}</a>
<a class="langsw" href="/admin/lang/${lang === 'ar' ? 'fr' : 'ar'}">${lang === 'ar' ? 'Français' : 'العربية'}</a>
<a href="/admin/profile" class="me">${esc(lang === 'ar' ? user.name_ar || user.username : user.name_fr || user.username)}</a>
<form method="post" action="/admin/logout" class="inline">${csrfField(c)}<button class="btn gh sm">${esc(L('خروج', 'Quitter'))}</button></form></header>
<div class="alay"><aside id="asb">${nav}<a href="/${lang}" target="_blank" rel="noopener" class="site"><span class="ic">↗</span>${esc(L('عرض الموقع', 'Voir le site'))}</a></aside>
<main class="amain"><h1 class="pt">${back ? `<a class="back" href="${esc(back)}">‹</a> ` : ''}${esc(title)}</h1>${flash}${body}</main></div>
<script src="/js/admin.js" defer></script></body></html>`;
}

const STATUS_LABEL = {
  draft: ['مسودة', 'Brouillon'], pending: ['قيد المراجعة', 'En relecture'], rejected: ['مرفوض', 'Refusé'], scheduled: ['مجدول', 'Programmé'], published: ['منشور', 'Publié'], archived: ['مؤرشف', 'Archivé'],
};
const badge = (c, status) => `<span class="badge st-${status}">${esc(c.L(...STATUS_LABEL[status]))}</span>`;
const table = (heads, rows) => `<div class="tw"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${heads.length}" class="meta">—</td></tr>`}</tbody></table></div>`;
const dt = (c, v) => fmtDate(v, c.lang, true);

module.exports = { ctxFor, shell, csrfField, postForm, btn, badge, table, dt, STATUS_LABEL, MSG, ERR, esc };
