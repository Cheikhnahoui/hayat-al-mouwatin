# Progress checklist

Legend: ✅ done and tested · 🟡 done, needs real-world review · ⬜ not started

| Phase | Status | Notes |
|---|---|---|
| 1. Repository analysis and plan | ✅ | The repo contained one static `index.html` (vanilla JS SPA, mock data, no backend). Prototype moved to `legacy/prototype.html`; logo extracted to `public/img/logo.png`; CSS extracted to `public/css/site.css` |
| 2. Public website | ✅ | Home (dynamic sections, featured, ticker, ads), article, category with pagination, tag, author, search (title / content / category / author + date and category filters), RSS |
| 3. Database and backend | ✅ | 24 tables, foreign keys, indexes, migrations, seed |
| 4. Auth and RBAC | ✅ | 5 roles, 24 permissions, per-user overrides, lockout, CSRF |
| 5. Admin dashboard | ✅ | Real statistics, traffic chart, activity feed, review queue |
| 6. CMS and workflow | ✅ | Rich editor with AR / FR tabs, media picker, tags, SEO fields, revisions, scheduling, featured / breaking |
| 7. Localization | ✅ | /ar and /fr, RTL / LTR, hreflang, sitemap, missing-translation notice |
| 8. Media, ads, notifications, comments | ✅ | |
| 9. SEO, security, performance | 🟡 | NewsArticle JSON-LD, Open Graph / Twitter cards, canonical, srcset and lazy images, CSP. To review: HTTP caching of HTML, FTS5 search if the archive grows beyond ~50k articles |
| 10. Testing and docs | 🟡 | 16 automated end-to-end tests pass. Manual mobile / browser QA on real devices still to do |

## Known follow-ups

* Visual QA on real iPhone / Android devices and a screen-reader pass.
* Optional: e-mail notifications, 2FA for admins, shared session store if scaling beyond one instance.
* Optional: role / permission editor UI (today: per-user overrides plus the definitions in `src/lib/rbac.js`).
* Ad impressions are counted on page render (bots excluded by user-agent); stricter viewability tracking could be added.
