# DTL Chapter Page Renderer Lab

This is the experimental PDF-to-image renderer for the Dropbox reader lab.

The service accepts a PDF in the request body, renders one requested page with
Poppler, and returns an image. It can also keep a small, short-lived cache of
source PDFs so the Worker does not have to re-download and re-send the whole PDF
for every page in the same reading session.

It should only be reached through the lab Worker's internal Cloudflare Container
binding.

## Routes

- `GET /health`
- `GET /documents/{document_key}`
- `POST /render-page?page=1&format=png`

The document cache is intentionally conservative: it keeps at most four PDFs for
about 20 minutes and still renders only pages the patron actually opens.

## Local check

```sh
python3 -m py_compile app.py
```

## Deploy shape

The included `Dockerfile` installs `poppler-utils` and runs FastAPI with
Uvicorn. Cloudflare Containers are the intended first proof because they can run
proven native PDF rendering tools without putting Dropbox credentials in the
browser or creating a separate Google Cloud project.
