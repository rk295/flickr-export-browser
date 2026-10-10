# AGENTS.md

Guidance for AI coding agents working in this repo.

## What this is

Read-only web UI over static Flickr export data (JSON + original images). Node 22, Express, sharp; vanilla-JS single-page frontend with no build step.

## Layout

- `server.mjs` — everything server side: scans `DATA_DIR`, loads each account into memory, thumbnail queue, HTTP API, media serving.
- `public/index.html`, `public/style.css`, `public/app.js` — SPA, hash-routed `#/<user>/<tab>/<arg>?query`. `?p=<photoId>` opens the lightbox over any view.
- `docker-compose.yml` — generic: mounts `${DATA_DIR}` read-only at `/data`, cache at `/cache`, publishes `HTTP_PORT`. Host-specific config (Traefik labels, hostnames, data path) lives in `docker-compose.override.yml` and the gitignored `.env`. The override is committed to the private Gitea repo only and must be excluded from any public export; templates are `.env.example` and `docker-compose.override.yml.example`. Don't put hostnames or labels in the committed compose file.
- `.github/workflows/` (shared by Gitea Actions and GitHub Actions) — lint and build CI.

## API

- `GET /api/users`, `/api/u/:user`, `/api/u/:user/photos`, `/api/status`
- `GET /media/:user/:photoId/:kind` — `t` thumb, `p` preview, `o` original

## Conventions and gotchas

- Account = sub-directory of `DATA_DIR`. Never build filesystem paths from request input; look up users and photo IDs in the in-memory maps (see the `/media` handler).
- Photo ↔ file matching: any run of 6+ digits in a media filename is indexed; `photo_<id>.json` finds its file by ID.
- Flickr geo values are microdegrees (e.g. `51585429`); `server.mjs` normalises them.
- Dates are `YYYY-MM-DD HH:MM:SS` strings; album `created` is a unix timestamp. Compare as strings, avoid `Date` timezone conversions.
- Export HTML (descriptions, mail, comments) is untrusted: always render through `sanitize()` / `rich()` in `app.js`, escape everything else with `esc()`.
- Rescans run every 60s; the data dir may be mid-copy. Don't cache thumbs from files modified in the last 60s.
- The `cache/` dir (thumbs + `dims.json`) is disposable and gitignored. `node_modules/` too.
- Never commit export data. Screenshots in `docs/` are the only photos in the repo and are deliberately chosen; check any new ones for private content (faces, emails) before committing.

## Checks

```sh
npm run lint
node --check server.mjs && node --check public/app.js
```

Test locally against real data with `DATA_DIR=... CACHE_DIR=/tmp/x PORT=8099 node server.mjs`, then deploy with `docker compose up -d --build`.
