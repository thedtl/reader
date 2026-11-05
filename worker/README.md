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
- `OPENAI_API_KEY`: server-only key for the metadata scanner's Luna requests.
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
- `POST /suggest-heading`: staff-only metadata scan using OpenAI Responses,
  `gpt-5.6-luna`, high reasoning and image detail, up to 12,000 output tokens,
  `store: false`, and a 300-second request timeout. Its existing citation
  normalization, response shape and text heuristic fallback are unchanged.
  `GEMINI_API_KEY` and `GEMINI_MODEL` are no longer used by this route.
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
npm run check
npm test
```

The Luna migration also reconciles seven pre-existing ToC payload fields from
deployed Worker version `e1ef4c33-5cb3-4858-b0ab-ee4b22dd9ca0` (2026-07-18).
They were absent from repository HEAD `5dbedd9` and are retained here to avoid
reverting deployed forwarding behavior. No ToC endpoint or reader contract changes.
All 26 metadata tests and syntax checks pass. The rebuilt routing region matches
the deployed version byte-for-byte. One live Luna API check on supplied title-page
text completed in 5.545 seconds (2,306 input and 582 output tokens, including 391
reasoning tokens). This verifies the API/response handoff, not image accuracy;
the original scanner's citation rules and heuristic fallback remain unchanged.

Released 2026-11-05: source `393f6ee`, Worker version
`27d562e2-dc7a-4a2c-be7a-5cda240b249f` at 100%. The existing bookmarker key was
copied directly into an encrypted `OPENAI_API_KEY` binding; no new credential,
account, GCP secret or IAM grant. Deployed code matches the tested bundle.
Health, CORS and unauthorized metadata/reader requests pass. Existing runtime,
bindings and ToC/reader routes are preserved; the old Gemini key is unused.
No Cloud Run revision, stable-service traffic or PDF processing was touched.

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
