# حياة المواطن · Hayat Al Mouwatin

Bilingual (Arabic RTL / French LTR) Mauritanian news platform with a full CMS, editorial workflow, role-based administration, media library, advertising, comments, notifications and SEO.

The original single-file prototype is preserved in [`legacy/prototype.html`](legacy/prototype.html). Its design (burgundy / white palette, Cairo font, editorial layout) is carried over in `public/css/site.css`.

## Stack

Node.js >= 22 · Express 5 · SQLite (better-sqlite3, WAL) · server-rendered pages (SEO-friendly, no client framework) · sharp (image optimisation) · sanitize-html · helmet.
No external service is required: one process, one database file, one uploads folder.

## Quick start (development)

```bash
npm install
cp .env.example .env          # edit values (NODE_ENV=development for local work)
npm run migrate               # create / update the database schema
npm run seed                  # roles, permissions, categories, default settings (idempotent)
npm run create-admin          # create the first Super Admin (interactive, password is never echoed)
npm run seed:demo             # OPTIONAL, dev only: 11 sample articles, demo staff, demo ads
npm run dev                   # http://localhost:3000   (admin: /admin)
npm test                      # end-to-end tests (use a temporary database)
```

`seed:demo` refuses to run when `NODE_ENV=production` and prints random passwords for the demo accounts once. Demo data is kept in separate scripts and never mixed with production seed.

### Creating the first Super Admin

* Interactive: `npm run create-admin`
* Non-interactive (Docker / CI): `ADMIN_USERNAME=... ADMIN_EMAIL=... ADMIN_NAME=... ADMIN_PASSWORD=... npm run create-admin`

Passwords need at least 10 characters with letters and digits. No credentials are hardcoded anywhere.

## Environment variables

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `production` enables secure cookies, HSTS and enforces `APP_SECRET` |
| `PORT` | HTTP port |
| `SITE_URL` | Public URL (canonical links, sitemap, Open Graph) |
| `DATABASE_PATH` | SQLite file (default `./data/hayat.db`) |
| `UPLOAD_DIR` | Media folder (default `./data/uploads`) |
| `APP_SECRET` | 32+ random characters (`openssl rand -hex 32`) |
| `TRUST_PROXY` | `1` when behind nginx / Caddy / Cloudflare |
| `MAX_IMAGE_MB`, `MAX_VIDEO_MB` | Upload limits |

## Production deployment

```bash
git clone https://github.com/Cheikhnahoui/hayat-al-mouwatin.git && cd hayat-al-mouwatin
npm ci --omit=dev
cp .env.example .env && nano .env      # NODE_ENV=production, SITE_URL, APP_SECRET, TRUST_PROXY=1
npm run migrate && npm run seed
npm run create-admin
npm start                              # or: pm2 start src/server.js --name hayat
```

* Put nginx or Caddy in front for HTTPS and proxy to `PORT`; set `TRUST_PROXY=1`.
* Back up `data/hayat.db` (`sqlite3 data/hayat.db ".backup backup.db"`) and the `data/uploads/` folder.
* Update: `git pull && npm ci --omit=dev && npm run migrate && pm2 restart hayat`.
* There is no build step. GitHub Pages cannot host this app because it needs a Node server: use a VPS, Render, Railway, Fly.io, etc.

## Architecture

```
src/server.js          app, security headers (CSP), background jobs (scheduled publishing, ad-expiry alerts)
src/db/                migrations (001_init.sql), seed, demo seed
src/lib/               rbac, auth, articles (workflow + revisions), content (public queries), media,
                       ads, comments, settings, notify, audit, sanitize
src/routes/public.js   /ar and /fr site, sitemap.xml, robots.txt, RSS, ad click redirect
src/routes/admin/      /admin (dashboard, articles, taxonomy, media, ads, users, misc)
src/views/             server-rendered templates (public + admin)
src/i18n/              Arabic / French interface dictionaries
public/                css, client js (editor, media picker), logo
tests/e2e.test.js      16 end-to-end tests
```

### Bilingual model

`articles` hold the stable identity; `article_translations` hold one row per language (title, slug, summary, content, SEO title and description, `is_enabled`). An article can be published in Arabic only, French only, or both. Nothing is auto-translated. If a visitor opens `/fr/article/42` and no French version exists, they see a clear notice with a link to the Arabic version (`noindex`). Categories and tags are localized the same way. URLs use `/ar/...` and `/fr/...` prefixes, localized slugs, `hreflang` with `x-default`, and a multilingual sitemap.

### Roles

Super Admin (everything), Admin, Editor, Journalist, Advertising Manager. Permissions are defined in `src/lib/rbac.js` and stored in the database. Every route checks them on the server (`req.can(...)`) and workflow transitions re-check them in `src/lib/articles.js`. Super Admins can also grant or revoke individual permissions per user.

### Editorial workflow

`draft -> pending -> published | scheduled` or `rejected` (with a note), plus unpublish, archive / restore, delete and a revision history with restore. Notifications are stored in the database (read / unread). Scheduled articles are published by a background job that runs every minute.

### Security

scrypt password hashing · server-side sessions (hashed token, httpOnly, SameSite=Lax, Secure in production) · CSRF tokens on authenticated POSTs and a double-submit cookie on login · login rate limit and 5-failure / 15-minute lockout · parameterized SQL only · allow-list HTML sanitisation of article content (video iframes limited to YouTube / Vimeo) · output escaping · strict CSP (`script-src 'self'`) · upload validation by magic bytes (SVG rejected), EXIF stripped, images re-encoded to WebP · comment honeypot, time-trap, per-IP throttle and spam filter · audit log.

See [`docs/PROGRESS.md`](docs/PROGRESS.md) for the checklist and follow-ups.
