# Dropbox Worker Lab

This Cloudflare Worker is the server-side part of the Dropbox experiment.

It keeps Dropbox credentials out of the browser, signs chapter tokens, and
proxies PDF bytes from Dropbox to PDF.js.

## Secrets

Set these as Worker secrets, not as committed files:

- `DROPBOX_REFRESH_TOKEN`: durable Dropbox refresh token for server-side access.
- `DROPBOX_APP_KEY`: Dropbox app key.
- `DROPBOX_APP_SECRET`: Dropbox app secret.
- `TOKEN_SECRET`: long random string used to sign patron links.
- `STAFF_PASSWORD`: staff-only password for link generation routes.

For a quick short-lived smoke test only, `DROPBOX_ACCESS_TOKEN` can be used
instead of the three Dropbox refresh-token secrets. The refresh-token setup is
preferred because Dropbox access tokens expire.

## Routes

- `GET /health`
- `GET /sign?password=...&dropbox=...&start=1&end=10&chapter=...`
- `POST /batch-sign`
- `GET /analyze?password=...&dropbox=...`
- `GET /?token=...`

For the first proof of concept, `dropbox` can be a Dropbox API file reference
such as `/Folder/Book.pdf` or `id:...`, or a Dropbox shared link. Shared links
require the Dropbox app permission `sharing.read`.

Do not put Dropbox API tokens or secrets in the browser-facing reader. Signed
reader tokens keep the Dropbox file reference encrypted.

## Local check

```sh
node --check worker/src/index.js
```

## Deploy later

Do not deploy until the Dropbox app and secrets are ready.

```sh
wrangler secret put DROPBOX_REFRESH_TOKEN
wrangler secret put DROPBOX_APP_KEY
wrangler secret put DROPBOX_APP_SECRET
wrangler secret put TOKEN_SECRET
wrangler secret put STAFF_PASSWORD
wrangler deploy
```
