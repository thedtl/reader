# chapter-pdf-reader Dropbox lab

Experimental copy of the DTL chapter PDF reader.

This repo is for testing Dropbox-backed access, faster loading for large PDFs,
and stronger download prevention without changing the live patron-facing reader.

The live source repo remains: https://github.com/thedtl/chapter-pdf-reader

See `docs/dropbox-api-experiment-plan.md` before changing implementation code.

## First lab pieces

- `web/` and `build/`: copied PDF.js reader snapshot from the live repo.
- `docs/dropbox-api-experiment-plan.md`: security and performance plan.
- `worker/`: Cloudflare Worker scaffold for server-side Dropbox API access.
