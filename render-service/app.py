import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import Response


app = FastAPI(title="DTL Chapter Page Renderer Lab")


@app.get("/health")
def health():
    return {"ok": True, "service": "dtl-chapter-page-renderer-lab"}


@app.post("/render-page")
async def render_page(
    request: Request,
    page: int = Query(..., ge=1),
    format: str = Query("png", pattern="^(png|jpg|jpeg)$"),
):
    source_pdf = await request.body()
    if not source_pdf:
        raise HTTPException(status_code=400, detail="Missing PDF body")

    image_format = "jpeg" if format == "jpg" else format
    suffix = "jpg" if image_format == "jpeg" else image_format

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        pdf_path = temp_path / "source.pdf"
        output_prefix = temp_path / "page"
        pdf_path.write_bytes(source_pdf)

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
