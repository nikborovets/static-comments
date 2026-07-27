# static-comments

Portable, self-contained **text-review commenting** for any static HTML page.
Reviewers select text → leave a comment; comments + threaded replies are stored
centrally (SQLite). A side panel lists everything, hovering a card highlights
the exact fragment on the page, and everything exports to **Markdown** (for
reading) or **JSON** (for tooling) with a locator (`секция → блок N, index.html:LINE`).

No build step required in the host project, no external dependencies in the
browser (the widget injects its own CSS/DOM). No auth — **run on a trusted /
VPN-only network.**

This is a standalone, self-contained repo — drop it into any static-site
project as a git submodule (or just copy the folder in as-is):

```bash
git submodule add git@github.com:nikborovets/static-comments.git static-comments
```

```
static-comments/
├── app.py              backend (FastAPI + SQLite), also serves the widget
├── widget.js           the front-end widget (served at /widget.js)
├── annotate.py         OPTIONAL build-time block annotator (see below)
├── Dockerfile          builds the service image
├── docker-compose.yml  service definition (include or run standalone)
├── nginx.snippet.conf  optional reverse-proxy block
└── requirements.txt
```

## What reviewers get

- **Select text → 💬 Комментарий** → popover with the quote and a text field
  (Ctrl/Cmd+Enter sends).
- **Side panel** (floating `💬 N` button, N = unresolved count) listing every
  comment with its quote, author, time and locator.
- **Hover a card → the fragment highlights** on the page and scrolls into view.
  Nothing is highlighted until you hover, so the page stays clean.
- **Sort**: `По расположению` (default — top-to-bottom page order, grouped by
  section), `Сначала новые`, `Сначала старые`.
- **Filter** by reviewer.
- **Threaded replies** on each comment, plus `решено` / `удалить`.
- Reviewer name is asked once and kept in `localStorage` (`sgd_reviewer_name`).

## How it works

- The widget derives its API base from its own `<script src>`, so it works
  **behind a reverse proxy** (`/api/widget.js` → `/api/comments`) **or
  published directly** (`http://host:8000/widget.js` → `http://host:8000/comments`
  — for that case enable CORS, see config below).
- Comments anchor to a **block id + character offsets** when the page is
  annotated (see below); otherwise they fall back to a whitespace-normalized
  text search. Highlight + export work either way.

## Integrate (behind a reverse proxy — recommended)

1. **Run the service** — from the host project's `docker-compose.yml`:
   ```yaml
   include:
     - static-comments/docker-compose.yml
   services:
     my-site:
       # ...your static server (e.g. nginx)...
       depends_on:
         - static-comments
   ```
   On a shared host, prefix the image/container names from the parent project's
   `.env` (do **not** redeclare the service in the parent — older Compose fails
   with `conflicts with imported resource`):
   ```dotenv
   STATIC_COMMENTS_IMAGE=myprefix-static-comments
   STATIC_COMMENTS_CONTAINER=myprefix-static-comments
   ```
2. **Proxy `/api/`** to it — paste `nginx.snippet.conf` into your `server { }`.
   Note the `^~` modifier: without it a `\.js$` regex location would swallow
   `/api/widget.js` and serve a 404 from your static root.
3. **Add one line** to your page:
   ```html
   <script defer src="/api/widget.js"></script>
   ```

Keep `COMMENTS_ROOT_PATH` (in `docker-compose.yml`) equal to that prefix
(`/api`) so the built-in Swagger UI at `/api/docs` links to the right spec.

## Integrate (no reverse proxy)

1. In `docker-compose.yml` uncomment the `ports: ["8000:8000"]` block, set
   `COMMENTS_CORS_ORIGINS` to your page's origin, and set
   `COMMENTS_ROOT_PATH: ""`.
2. Add to your page (any host that can reach the service):
   ```html
   <script defer src="http://SERVER_IP:8000/widget.js"></script>
   ```

## Optional: block anchoring + source line numbers

`annotate.py` (stdlib only) stamps each commentable block (`p`, `li`,
`blockquote`, `td`, `th`, `dd`, `figcaption`) in your HTML with
`data-cmt-id="<section>:<n>"` and `data-cmt-line="<source line>"`, inserting the
attributes in place without reformatting the file. This makes highlighting exact
(no text search) and lets the export point back at `index.html:LINE`.

Run it at build time on your page before serving, e.g. in your site's Dockerfile:

```dockerfile
FROM python:3.12-slim AS annotate
WORKDIR /src
COPY your-site/ ./site/
COPY static-comments/annotate.py .
RUN python annotate.py site/index.html > site/index.annotated.html \
 && mv site/index.annotated.html site/index.html
# ...then COPY --from=annotate the annotated site into your web server image
```

Set `COMMENTS_SOURCE_FILE` in `docker-compose.yml` to match the file name you
want printed in the export locator.

Line numbers refer to the page version that was built. After you edit the page
and rebuild, the annotation is regenerated and later exports carry fresh line
numbers — `блок N` stays the stable part.

## API

| Method | Path                        | Purpose                          |
|--------|-----------------------------|----------------------------------|
| GET    | `/widget.js`                | the front-end widget (`no-store`)|
| GET    | `/comments?resolved=false`  | list comments (with replies)     |
| POST   | `/comments`                 | create a comment                 |
| PATCH  | `/comments/{id}`            | `{ "resolved": true }`           |
| DELETE | `/comments/{id}`            | delete (cascades to replies)     |
| POST   | `/comments/{id}/replies`    | add a reply                      |
| DELETE | `/replies/{id}`             | delete a reply                   |
| GET    | `/export.md`                | Markdown export (human-readable) |
| GET    | `/export.json`              | JSON export (machine-readable)   |
| GET    | `/health`                   | health check                     |
| GET    | `/docs`, `/openapi.json`    | Swagger UI + spec (see below)    |

Behind the proxy these live under the prefix, e.g. `/api/export.md`.

`/export.json` returns `{title, source_file, exported_at, count, comments[]}`
and is sent as a download (`comments.json`).

Swagger UI loads its assets from a CDN, so `/docs` needs outbound internet **in
the browser**. To switch the docs off entirely, add `docs_url=None,
redoc_url=None, openapi_url=None` to the `FastAPI(...)` call in `app.py`.

## Config (env vars)

| Var                    | Default              | Meaning                                   |
|------------------------|----------------------|-------------------------------------------|
| `COMMENTS_DB`          | `/data/comments.db`  | SQLite path (put on a volume)             |
| `COMMENTS_TITLE`       | `Комментарии ревью`  | H1 in the Markdown export                 |
| `COMMENTS_SOURCE_FILE` | `index.html`         | file name shown in the export locator     |
| `COMMENTS_ROOT_PATH`   | _(empty)_            | external path prefix the service is proxied under (e.g. `/api`), so `/docs` links correctly |
| `COMMENTS_CORS_ORIGINS`| _(empty = off)_      | CORS allow-list for cross-origin/standalone use; comma-separated, or `*`. Leave empty behind a same-origin proxy. |

The DB schema migrates itself in place on startup (missing columns are added),
so upgrading the service keeps existing comments.

## Security notes

- **No authentication** — anyone who can reach the service can read/edit/delete
  all comments. Run it on a trusted / VPN-only network (or put basic-auth on the
  reverse proxy). Do not expose to the public internet.
- **CORS is off by default** so a page a reviewer happens to visit can't tamper
  with comments cross-site. Only enable `COMMENTS_CORS_ORIGINS` for a standalone
  cross-origin deployment, ideally with an explicit origin (not `*`).
- Input lengths are capped and all SQL is parameterized; the widget renders all
  user text via `textContent` (no HTML injection); `blockId` is restricted to a
  safe charset server-side and escaped before use in a CSS selector.

## Data / housekeeping

- Comments persist in the `comments-data` volume (survive restarts).
- Wipe all data: `docker compose down -v`.
- Disable the widget on a page without redeploying: append `?comments=off`
  (persists per-browser); re-enable with `?comments=on`.
