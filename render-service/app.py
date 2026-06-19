import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import Response


app = FastAPI(title="DTL Chapter Page Renderer Lab")
CACHE_DIR = Path("/tmp/dtl-page-renderer-cache")
CACHE_TTL_SECONDS = 20 * 60
MAX_CACHED_DOCUMENTS = 4


@app.get("/health")
def health():
    return {"ok": True, "service": "dtl-chapter-page-renderer-lab"}


@app.get("/documents/{document_key}")
def document_status(document_key: str):
    document_path = cached_document_path(document_key)
    purge_stale_documents()
    return {"ok": document_path.exists()}


@app.post("/render-page")
async def render_page(
    request: Request,
    page: int = Query(..., ge=1),
    format: str = Query("png", pattern="^(png|jpg|jpeg)$"),
    document_key: Optional[str] = Query(None, pattern="^[A-Za-z0-9_-]{16,128}$"),
):
    source_pdf = await request.body()

    image_format = "jpeg" if format == "jpg" else format
    suffix = "jpg" if image_format == "jpeg" else image_format

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        pdf_path = prepare_source_pdf(document_key, source_pdf, temp_path)
        output_prefix = temp_path / "page"

        command = [
            "pdftoppm",
            f"-{image_format}",
            "-f",
            str(page),
            "-singlefile",
            "-r",
            "160",
            str(pdf_path),
            str(output_prefix),
        ]

        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "PDF render failed").strip()
            raise HTTPException(status_code=422, detail=detail[:500])

        image_path = output_prefix.with_suffix(f".{suffix}")
        if not image_path.exists():
            raise HTTPException(status_code=422, detail="Renderer did not create an image")

        media_type = "image/jpeg" if image_format == "jpeg" else "image/png"
        return Response(
            content=image_path.read_bytes(),
            media_type=media_type,
            headers={"cache-control": "private, no-store"},
        )


def prepare_source_pdf(document_key: Optional[str], source_pdf: bytes, temp_path: Path) -> Path:
    purge_stale_documents()

    if document_key:
        document_path = cached_document_path(document_key)
        if source_pdf:
            document_path.parent.mkdir(parents=True, exist_ok=True)
            document_path.write_bytes(source_pdf)
            enforce_cache_limit()
            return document_path
        if document_path.exists():
            document_path.touch()
            return document_path
        raise HTTPException(status_code=404, detail="Cached PDF is not available")

    if not source_pdf:
        raise HTTPException(status_code=400, detail="Missing PDF body")

    pdf_path = temp_path / "source.pdf"
    pdf_path.write_bytes(source_pdf)
    return pdf_path


def cached_document_path(document_key: str) -> Path:
    return CACHE_DIR / f"{document_key}.pdf"


def purge_stale_documents() -> None:
    if not CACHE_DIR.exists():
        return

    cutoff = time.time() - CACHE_TTL_SECONDS
    for path in CACHE_DIR.glob("*.pdf"):
        if path.stat().st_mtime < cutoff:
            path.unlink(missing_ok=True)


def enforce_cache_limit() -> None:
    documents = sorted(
        CACHE_DIR.glob("*.pdf"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in documents[MAX_CACHED_DOCUMENTS:]:
        path.unlink(missing_ok=True)
