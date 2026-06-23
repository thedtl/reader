# Dropbox Worker Lab

This Cloudflare Worker is the server-side part of the Dropbox experiment.

It keeps Dropbox credentials out of the browser, signs chapter tokens, and
creates chapter-only PDF responses for the lab reader.

## Secrets

Set these as Worker secrets, not as committed files:

- `DROPBOX_REFRESH_TOKEN`: durable Dropbox refresh token for server-side access.
- `DROPBOX_APP_KEY`: Dropbox app key.
- `DROPBOX_APP_SECRET`: Dropbox app secret.
- `TOKEN_SECRET`: long random string used to sign patron links.
- `STAFF_PASSWORD`: staff-only password for link generation routes.
- `DTL_STAFF_PASSWORD`: optional separate backend staff password for ToC
  Creator routes. When omitted, the staff-entered password is forwarded to the
  ToC backend.

For a quick short-lived smoke test only, `DROPBOX_ACCESS_TOKEN` can be used
instead of the three Dropbox refresh-token secrets. The refresh-token setup is
preferred because Dropbox access tokens expire.

## Variables

- `ALLOWED_ORIGINS`: allowed browser origins for CORS.
- `ALLOWED_PDF_REQUEST_ORIGINS`: origins allowed to request tokenized chapter
  PDFs. In production this should be the approved PDF.js reader origin.

## Routes

- `GET /health`
- `GET /sign?password=...&dropbox=...&start=1&end=10&chapter=...`
- `POST /batch-sign`
- `GET /analyze?password=...&dropbox=...`
- `POST /toc/health`
- `POST /toc/analyze`
- `POST /toc/metadata`
- `POST /toc/jobs`
- `POST /toc/job-status`
- `POST /toc/run-feedback`
- `POST /toc/runs/recent`
- `GET /toc/source?token=...` is an internal short-lived source-PDF URL used by
  the ToC backend. Staff should keep using the ToC Creator UI rather than
  opening this route directly.
- `GET /reader-session?token=...` returns a short-lived reader session for the
  approved PDF.js viewer.
- `GET /?token=...` returns a temporary PDF containing only the token's page
  range. Patron PDF requests must include a valid `session=...` value.

For the first proof of concept, `dropbox` can be a Dropbox API file reference
such as `/Folder/Book.pdf` or `id:...`, or a Dropbox shared link. Shared links
require the Dropbox app permission `sharing.read`.

Do not put Dropbox API tokens or secrets in the browser-facing reader. Signed
reader tokens keep the Dropbox file reference encrypted.

Staff bookmark extraction can still use `/analyze` to let PDF.js inspect the
original bookmarked PDF. Patron links use `/?token=...`, which assembles a
chapter-only PDF before sending bytes to the browser.

To make copied URLs harder to reuse, the long-lived chapter token is not enough
to fetch PDF bytes. The PDF.js viewer first asks `/reader-session` for a
short-lived session, then PDF.js uses `/?token=...&session=...` internally.
Tokenized PDF requests must also come from an allowed reader origin. A raw Worker
URL pasted into a new tab should fail even when the token itself is valid.

For patron tokens, the original source page range is encrypted in the private
token payload. The public token range is rewritten to `1..chapter length` so the
reader works against the temporary chapter-only PDF, not the source PDF's page
numbers.

## Local check

```sh
node --check src/index.js
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
