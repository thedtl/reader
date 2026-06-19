export function createChapterImageHandlers(deps) {
  return {
    handleChapterManifest: (request, env) => handleChapterManifest(request, env, deps),
    handleChapterPageImage: (request, env) => handleChapterPageImage(request, env, deps),
  };
}

async function handleChapterManifest(request, env, deps) {
  const payload = await requireChapterImagePayload(request, env, deps);
  return deps.json({
    mode: "image",
    title: payload.c || "Chapter",
    pageCount: payload.e,
    firstPage: 1,
    lastPage: payload.e,
    imageFormat: "png",
    restrictionMode: "chapter-page-images",
  }, request, env);
}

async function handleChapterPageImage(request, env, deps) {
  const url = new URL(request.url);
  const payload = await requireChapterImagePayload(request, env, deps);
  const chapterPage = deps.parsePositiveInteger(url.searchParams.get("page"), "page");
  if (chapterPage > payload.e) {
    throw new deps.HttpError(404, "Page is outside this chapter");
  }

  const sourcePage = payload.ss + chapterPage - 1;
  if (sourcePage > payload.se) {
    throw new deps.HttpError(404, "Page is outside this chapter");
  }

  const accessToken = await deps.getDropboxAccessToken(env);
  const downloadRef = await deps.resolveDropboxRefForDownload(accessToken, payload.dbx);
  const dropboxResponse = await deps.fetchDropboxPdf(new Request(request.url), accessToken, downloadRef);

  if (!dropboxResponse.ok) {
    return deps.dropboxErrorResponse(dropboxResponse, request, env);
  }

  const sourceBytes = await dropboxResponse.arrayBuffer();
  const renderedPage = await renderPdfPage(sourceBytes, sourcePage, env, deps);

  const headers = deps.corsHeaders(request, env);
  headers.set("content-type", renderedPage.contentType);
  headers.set("content-length", String(renderedPage.bytes.byteLength));
  headers.set("cache-control", "private, no-store");
  headers.set("accept-ranges", "none");
  headers.set("x-dtl-restriction-mode", "chapter-page-images");
  headers.set("x-dtl-chapter-page", String(chapterPage));

  return new Response(request.method === "HEAD" ? null : renderedPage.bytes, {
    status: 200,
    headers,
  });
}

async function requireChapterImagePayload(request, env, deps) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    throw new deps.HttpError(401, "Missing token");
  }

  const payload = await deps.verifyToken(token, env);
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new deps.HttpError(401, "Token expired");
  }
  if (payload.m !== "image") {
    throw new deps.HttpError(400, "This token is not an image-reader token");
  }
  return payload;
}

async function renderPdfPage(sourceBytes, sourcePage, env, deps) {
  if (!env.PAGE_RENDERER) {
    throw new deps.HttpError(500, "Missing PAGE_RENDERER binding");
  }

  const rendererUrl = new URL("http://page-renderer/render-page");
  rendererUrl.searchParams.set("page", String(sourcePage));
  rendererUrl.searchParams.set("format", "png");

  const renderer = env.PAGE_RENDERER.getByName("default");
  const response = await renderer.fetch(rendererUrl, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
    },
    body: sourceBytes,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new deps.HttpError(502, `Renderer failed: ${details.slice(0, 300)}`);
  }

  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") || "image/png",
  };
}
