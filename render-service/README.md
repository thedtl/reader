# DTL Chapter Page Renderer Lab

This is the experimental PDF-to-image renderer for the Dropbox reader lab.

The service accepts a PDF in the request body, renders one requested page with
Poppler, and returns an image. It should only be reached through the lab
Worker's internal Cloudflare Container binding.

## Routes

- `GET /health`
- `POST /render-page?page=1&format=png`

## Local check

```sh
python3 -m py_compile app.py
```

## Deploy shape

The included `Dockerfile` installs `poppler-utils` and runs FastAPI with
Uvicorn. Cloudflare Containers are the intended first proof because they can run
proven native PDF rendering tools without putting Dropbox credentials in the
browser or creating a separate Google Cloud project.
