# Manual Setup Checklist

This experiment needs a few manual setup steps because Dropbox and Cloudflare
secrets should not be pasted into chat or committed to GitHub.

## Dropbox

Goal: create a Dropbox app/token that lets the Worker read PDFs server-side.

Needed later:

- Dropbox app with file read permission.
- A Dropbox access token or refresh-token setup suitable for the account that
  owns the PDFs.
- A test PDF file reference, preferably a Dropbox API file ID such as `id:...`
  or a path such as `/Folder/Book.pdf`.

Do not put the Dropbox token in browser JavaScript, GitHub Pages, or a committed
file.

## Cloudflare Worker

Goal: store secrets in Cloudflare and deploy the lab Worker.

Needed later:

- `DROPBOX_ACCESS_TOKEN`
- `TOKEN_SECRET`
- `STAFF_PASSWORD`

These should be set with `wrangler secret put ...` or through the Cloudflare
dashboard's Worker secret settings.

## First live test

After secrets are set:

1. Deploy the lab Worker.
2. Generate a staff-only signed test token for one Dropbox PDF.
3. Open the lab PDF.js viewer with `file=` pointed at the lab Worker URL.
4. Confirm the PDF loads.
5. Confirm browser network requests do not show a Dropbox API token.
6. Confirm browser network requests do not show a Dropbox shared link.
7. Compare large-PDF load behavior with the live reader.

## Important limitation

The first Worker scaffold streams the PDF to PDF.js. This is useful for speed
testing and keeping Dropbox private, but a technical patron may still be able to
save PDF bytes that reach their browser.

If the first test is fast enough but still exposes too much content, the next
experiment should render chapter pages as images or tiles so the original PDF
never reaches the browser.
