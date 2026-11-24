'use strict';
const config = require('../config');
const enc = (s) => encodeURIComponent(s);
const articlePath = (lang, a) => `/${lang}/article/${a.id}-${enc(a.slug || 'article')}`;
const categoryPath = (lang, slug) => `/${lang}/category/${enc(slug)}`;
const tagPath = (lang, slug) => `/${lang}/tag/${enc(slug)}`;
const authorPath = (lang, id) => `/${lang}/author/${id}`;
const abs = (p) => config.siteUrl + p;
module.exports = { articlePath, categoryPath, tagPath, authorPath, abs };
