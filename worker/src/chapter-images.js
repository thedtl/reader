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

  const documentKey = await deps.sha256Base64Url(`dropbox-source:${payload.dbx}`);
  let rendererHasSourcePdf = await rendererHasDocument(documentKey, env, deps);
  let sourceBytes = null;

  if (!rendererHasSourcePdf) {
    const download = await downloadSourcePdf(request, env, payload, deps);
    if (download.response) {
      return download.response;
    }
    sourceBytes = download.bytes;
  }

  let renderedPage;
  try {
    renderedPage = await renderPdfPage(sourceBytes, sourcePage, documentKey, env, deps);
  } catch (error) {
    if (!rendererHasSourcePdf || error.rendererStatus !== 404) {
      throw error;
    }

    const download = await downloadSourcePdf(request, env, payload, deps);
    if (download.response) {
      return download.response;
    }
    rendererHasSourcePdf = false;
    renderedPage = await renderPdfPage(download.bytes, sourcePage, documentKey, env, deps);
  }

  const headers = deps.corsHeaders(request, env);
  headers.set("content-type", renderedPage.contentType);
  headers.set("content-length", String(renderedPage.bytes.byteLength));
  headers.set("cache-control", "private, no-store");
  headers.set("accept-ranges", "none");
  headers.set("x-dtl-restriction-mode", "chapter-page-images");
  headers.set("x-dtl-chapter-page", String(chapterPage));
  headers.set("x-dtl-renderer-document-cache", rendererHasSourcePdf ? "hit" : "miss");

  return new Response(request.method === "HEAD" ? null : renderedPage.bytes, {
    status: 200,
    headers,
  });
}

async function downloadSourcePdf(request, env, payload, deps) {
  const accessToken = await deps.getDropboxAccessToken(env);
  const downloadRef = await deps.resolveDropboxRefForDownload(accessToken, payload.dbx);
  const dropboxResponse = await deps.fetchDropboxPdf(new Request(request.url), accessToken, downloadRef);

  if (!dropboxResponse.ok) {
    return {
      response: await deps.dropboxErrorResponse(dropboxResponse, request, env),
    };
  }

  return {
    bytes: await dropboxResponse.arrayBuffer(),
  };
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

async function rendererHasDocument(documentKey, env, deps) {
  if (!env.PAGE_RENDERER) {
    throw new deps.HttpError(500, "Missing PAGE_RENDERER binding");
  }

  const renderer = env.PAGE_RENDERER.getByName("default");
  const response = await renderer.fetch(`http://page-renderer/documents/${documentKey}`);
  if (!response.ok) {
    return false;
  }

  const status = await response.json().catch(() => ({}));
  return status.ok === true;
}

async function renderPdfPage(sourceBytes, sourcePage, documentKey, env, deps) {
  if (!env.PAGE_RENDERER) {
    throw new deps.HttpError(500, "Missing PAGE_RENDERER binding");
  }

  const rendererUrl = new URL("http://page-renderer/render-page");
  rendererUrl.searchParams.set("page", String(sourcePage));
  rendererUrl.searchParams.set("format", "png");
  rendererUrl.searchParams.set("document_key", documentKey);

  const renderer = env.PAGE_RENDERER.getByName("default");
  const response = await renderer.fetch(rendererUrl, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
    },
    body: sourceBytes || undefined,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    const error = new deps.HttpError(502, `Renderer failed: ${details.slice(0, 300)}`);
    error.rendererStatus = response.status;
    throw error;
  }

  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") || "image/png",
  };
}
