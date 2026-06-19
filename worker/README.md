# Dropbox Worker Lab

This Cloudflare Worker is the server-side part of the Dropbox experiment.

It keeps Dropbox credentials out of the browser, signs chapter tokens, and
creates chapter-only PDF responses for the older lab path. The image-reader
experiment adds routes that validate the same signed token, fetch the source PDF
server-side, call an internal Cloudflare Container renderer, and return page
images to the patron browser.

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

## Variables

- `ALLOWED_ORIGINS`: allowed browser origins for CORS.

## Routes

- `GET /health`
- `GET /sign?password=...&dropbox=...&start=1&end=10&chapter=...`
- `POST /batch-sign`
- `GET /analyze?password=...&dropbox=...`
- `GET /?token=...` returns a temporary PDF containing only the token's page
  range.
- `GET /chapter-manifest?token=...` returns image-reader chapter metadata.
- `GET /chapter-page?token=...&page=1` returns one rendered page image for the
  image reader.

For the first proof of concept, `dropbox` can be a Dropbox API file reference
such as `/Folder/Book.pdf` or `id:...`, or a Dropbox shared link. Shared links
require the Dropbox app permission `sharing.read`.

Do not put Dropbox API tokens or secrets in the browser-facing reader. Signed
reader tokens keep the Dropbox file reference encrypted.

Staff bookmark extraction can still use `/analyze` to let PDF.js inspect the
original bookmarked PDF. The older PDF lab path uses `/?token=...`, which
assembles a chapter-only PDF before sending bytes to the browser.

The image-reader path signs tokens with `mode=image`. Patron pages then use
`/chapter-manifest` and `/chapter-page`. The browser receives image bytes only;
the Dropbox link, Dropbox file reference, source PDF, and source page range stay
inside the Worker/container backend path.

To keep page turns faster without creating avoidable render costs, the Worker
asks the renderer whether it already has the source PDF cached before downloading
from Dropbox again. The browser caches only pages the patron actually opens; it
does not pre-render unopened pages.

For patron tokens, the original source page range is encrypted in the private
token payload. The public token range is rewritten to `1..chapter length` so the
reader works against the temporary chapter-only PDF, not the source PDF's page
numbers.

## Local check

```sh
node --check src/index.js
node --check src/chapter-images.js
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
