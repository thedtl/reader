# Manual Setup Checklist

This experiment needs a few manual setup steps because Dropbox and Cloudflare
secrets should not be pasted into chat or committed to GitHub.

## Dropbox

Goal: create a Dropbox app/token that lets the Worker read PDFs server-side.

Needed later:

- Dropbox app with file read permission.
- A Dropbox refresh-token setup suitable for the account that owns the PDFs.
- A test PDF file reference, preferably a Dropbox API file ID such as `id:...`
  or a path such as `/Folder/Book.pdf`.

Do not put the Dropbox token in browser JavaScript, GitHub Pages, or a committed
file.

## Cloudflare Worker

Goal: store secrets in Cloudflare and deploy the lab Worker.

Needed later:

- `DROPBOX_REFRESH_TOKEN`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `TOKEN_SECRET`
- `STAFF_PASSWORD`

These should be set with `wrangler secret put ...` or through the Cloudflare
dashboard's Worker secret settings.

For a quick smoke test only, the Worker can use `DROPBOX_ACCESS_TOKEN` instead
of the three Dropbox refresh-token secrets. The refresh-token setup is preferred
because Dropbox access tokens expire.

## Page renderer container

Goal: render one source PDF page to an image without exposing the PDF to the
patron browser.

The lab renderer lives in `render-service/`. It is intentionally separate from
the Worker so PDF rasterization can use Poppler in a Cloudflare Container
instead of being forced into Worker limits.

Needed later:

- Docker or Colima running locally so Wrangler can build the container image.
- `@cloudflare/containers` installed in the Worker package.
- `PAGE_RENDERER` bound as a Durable Object backed by the `PageRenderer`
  container class.

## First live test

After secrets are set:

1. Deploy the lab Worker.
2. Generate a staff-only signed test token for one Dropbox PDF chapter.
3. Open the lab PDF.js viewer with `file=` pointed at the lab Worker URL.
4. Confirm the PDF loads and the Worker response header says
   `x-dtl-restriction-mode: chapter-only-pdf`.
5. Confirm browser network requests do not show a Dropbox API token.
6. Confirm browser network requests do not show a Dropbox shared link.
7. Confirm the browser receives only the selected chapter pages, not the full
   source PDF page count.
8. Compare large-PDF load behavior with the live reader.

## First image-reader test

After the Worker and renderer container are deployed:

1. Generate a staff-only signed test token with `mode=image`.
2. Open `web/image-reader.html` with the lab Worker URL and signed token.
3. Confirm the reader loads a chapter manifest.
4. Confirm `/chapter-page?token=...&page=1` returns an image content type.
5. Confirm the browser Network tab does not show a PDF response for the patron
   reader page.
6. Confirm the Dropbox shared link, Dropbox file reference, and source PDF are
   not visible in page source or Network URLs.

## Important limitation

The Worker now creates a temporary chapter-only PDF for patron links, which is a
stronger restriction than simply hiding PDF.js buttons.

This still sends PDF bytes for the selected chapter to the browser. If that is
still too permissive, the next experiment should render chapter pages as images
or tiles.
