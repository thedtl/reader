# Dropbox Worker Lab

This Cloudflare Worker is the server-side part of the Dropbox experiment.

It keeps Dropbox credentials out of the browser, signs chapter tokens, and
proxies PDF bytes from Dropbox to PDF.js.

## Secrets

Set these as Worker secrets, not as committed files:

- `DROPBOX_ACCESS_TOKEN`: Dropbox API token with file read access.
- `TOKEN_SECRET`: long random string used to sign patron links.
- `STAFF_PASSWORD`: staff-only password for link generation routes.

## Routes

- `GET /health`
- `GET /sign?password=...&dropbox=...&start=1&end=10&chapter=...`
- `POST /batch-sign`
- `GET /analyze?password=...&dropbox=...`
- `GET /?token=...`

For the first proof of concept, `dropbox` should be a Dropbox API file
reference such as `/Folder/Book.pdf` or `id:...`. Do not put Dropbox API tokens
or secrets in the browser-facing reader.

## Local check

```sh
node --check worker/src/index.js
```

## Deploy later

Do not deploy until the Dropbox app and secrets are ready.

```sh
wrangler secret put DROPBOX_ACCESS_TOKEN
wrangler secret put TOKEN_SECRET
wrangler secret put STAFF_PASSWORD
wrangler deploy
```
