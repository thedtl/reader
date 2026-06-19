const DROPBOX_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";
const DROPBOX_SHARED_LINK_FILE_URL = "https://content.dropboxapi.com/2/sharing/get_shared_link_file";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

let cachedDropboxAccessToken = null;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, service: "dtl-chapter-reader-dropbox-lab" }, request, env);
      }

      if (url.pathname === "/sign" && request.method === "GET") {
        return await handleSign(request, env);
      }

      if (url.pathname === "/batch-sign" && request.method === "POST") {
        return await handleBatchSign(request, env);
      }

      if (url.pathname === "/analyze" && (request.method === "GET" || request.method === "HEAD")) {
        return await handleAnalyze(request, env);
      }

      if (request.method === "GET" || request.method === "HEAD") {
        return await handlePdfRequest(request, env);
      }

      return json({ error: "Method not allowed" }, request, env, 405);
    } catch (error) {
      return json(
        { error: error.message || "Unexpected worker error" },
        request,
        env,
        error.status || 500,
      );
    }
  },
};

async function handleSign(request, env) {
  requireStaffPassword(request, env);

  const url = new URL(request.url);
  const payload = buildPayload({
    dropbox: url.searchParams.get("dropbox") || url.searchParams.get("path"),
    start: url.searchParams.get("start"),
    end: url.searchParams.get("end"),
    chapter: url.searchParams.get("chapter") || url.searchParams.get("c"),
    download: url.searchParams.get("download"),
    expires: url.searchParams.get("expires"),
  });

  const token = await signToken(payload, env);
  return json({ token, payload: publicPayload(payload) }, request, env);
}

async function handleBatchSign(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Invalid JSON body" }, request, env, 400);
  }

  requireStaffPasswordValue(body.password, env);

  if (!Array.isArray(body.chapters) || body.chapters.length === 0) {
    return json({ error: "chapters must be a non-empty array" }, request, env, 400);
  }

  const tokens = [];
  for (const chapter of body.chapters) {
    const payload = buildPayload({
      dropbox: body.dropbox || body.path,
      start: chapter.start,
      end: chapter.end,
      chapter: chapter.title || chapter.chapter || chapter.name,
      download: body.download,
      expires: body.expires,
    });
    tokens.push({
      title: payload.c,
      start: payload.s,
      end: payload.e,
      token: await signToken(payload, env),
    });
  }

  return json({ tokens }, request, env);
}

async function handleAnalyze(request, env) {
  requireStaffPassword(request, env);

  const url = new URL(request.url);
  const dropboxRef = normalizeDropboxRef(url.searchParams.get("dropbox") || url.searchParams.get("path"));
  return proxyDropboxPdf(request, env, dropboxRef);
}

async function handlePdfRequest(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return json({ error: "Missing token" }, request, env, 401);
  }

  const payload = await verifyToken(token, env);
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    return json({ error: "Token expired" }, request, env, 401);
  }

  return proxyDropboxPdf(request, env, payload.dbx);
}

async function proxyDropboxPdf(request, env, dropboxRef) {
  const accessToken = await getDropboxAccessToken(env);

  const dropboxHeaders = new Headers({
    authorization: `Bearer ${accessToken}`,
    "dropbox-api-arg": JSON.stringify(dropboxDownloadArg(dropboxRef)),
  });

  const range = request.headers.get("range");
  if (range) {
    dropboxHeaders.set("range", range);
  }

  const dropboxResponse = await fetch(dropboxDownloadUrl(dropboxRef), {
    method: "POST",
    headers: dropboxHeaders,
  });

  if (!dropboxResponse.ok && dropboxResponse.status !== 206 && dropboxResponse.status !== 416) {
    const details = await dropboxResponse.text().catch(() => "");
    const safeDetails = summarizeDropboxError(details);
    console.warn("Dropbox download failed", {
      status: dropboxResponse.status,
      details: safeDetails,
    });
    return json(
      {
        error: "Dropbox download failed",
        status: dropboxResponse.status,
        details: safeDetails,
        hint: dropboxErrorHint(safeDetails),
      },
      request,
      env,
      502,
    );
  }

  const headers = corsHeaders(request, env);
  copyHeader(dropboxResponse.headers, headers, "accept-ranges");
  copyHeader(dropboxResponse.headers, headers, "content-length");
  copyHeader(dropboxResponse.headers, headers, "content-range");
  copyHeader(dropboxResponse.headers, headers, "etag");
  copyHeader(dropboxResponse.headers, headers, "last-modified");
  headers.set("content-type", dropboxResponse.headers.get("content-type") || "application/pdf");
  headers.set("cache-control", "private, no-store");
  headers.set("x-dtl-restriction-mode", "full-pdf-streaming");

  const body = request.method === "HEAD" ? null : dropboxResponse.body;
  return new Response(body, {
    status: dropboxResponse.status,
    headers,
  });
}

async function getDropboxAccessToken(env) {
  if (env.DROPBOX_ACCESS_TOKEN) {
    return env.DROPBOX_ACCESS_TOKEN;
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedDropboxAccessToken && cachedDropboxAccessToken.expiresAt > now + 60) {
    return cachedDropboxAccessToken.token;
  }

  requireEnv(env, "DROPBOX_REFRESH_TOKEN");
  requireEnv(env, "DROPBOX_APP_KEY");
  requireEnv(env, "DROPBOX_APP_SECRET");

  const response = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.DROPBOX_REFRESH_TOKEN,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new HttpError(502, `Dropbox token refresh failed: ${details.slice(0, 300)}`);
  }

  const tokenData = await response.json();
  if (!tokenData.access_token) {
    throw new HttpError(502, "Dropbox token refresh response did not include an access token");
  }

  cachedDropboxAccessToken = {
    token: tokenData.access_token,
    expiresAt: now + Number(tokenData.expires_in || 14400),
  };

  return cachedDropboxAccessToken.token;
}

function buildPayload(input) {
  const dropboxRef = normalizeDropboxRef(input.dropbox);
  const start = parsePositiveInteger(input.start, "start");
  const end = parsePositiveInteger(input.end, "end");

  if (end < start) {
    throw new HttpError(400, "end must be greater than or equal to start");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    dbx: dropboxRef,
    s: start,
    e: end,
    d: isTruthy(input.download) ? 1 : 0,
    c: String(input.chapter || "Chapter").slice(0, 180),
    iat: now,
  };

  const expiresMinutes = Number(input.expires || 0);
  if (Number.isFinite(expiresMinutes) && expiresMinutes > 0) {
    payload.exp = now + Math.floor(expiresMinutes * 60);
  }

  return payload;
}

function normalizeDropboxRef(value) {
  const ref = String(value || "").trim();
  if (!ref) {
    throw new HttpError(400, "Missing Dropbox file reference");
  }

  if (/^https?:\/\//i.test(ref)) {
    try {
      const url = new URL(ref);
      if (url.hostname === "dropbox.com" || url.hostname.endsWith(".dropbox.com")) {
        return ref;
      }
    } catch {}
    throw new HttpError(400, "Dropbox URL must be a dropbox.com shared link");
  }

  if (ref.startsWith("/") || ref.startsWith("id:") || ref.startsWith("rev:")) {
    return ref;
  }

  throw new HttpError(400, "Dropbox reference must be a shared link, /path, id:, or rev:");
}

function dropboxDownloadUrl(dropboxRef) {
  return isDropboxSharedLink(dropboxRef) ? DROPBOX_SHARED_LINK_FILE_URL : DROPBOX_DOWNLOAD_URL;
}

function dropboxDownloadArg(dropboxRef) {
  return isDropboxSharedLink(dropboxRef) ? { url: dropboxRef } : { path: dropboxRef };
}

function isDropboxSharedLink(dropboxRef) {
  return /^https?:\/\/([^/]+\.)?dropbox\.com\//i.test(dropboxRef);
}

function summarizeDropboxError(details) {
  return String(details || "")
    .replace(/https?:\/\/[^\s"']*dropbox[^\s"']*/gi, "[dropbox-link]")
    .slice(0, 500);
}

function dropboxErrorHint(details) {
  const text = String(details || "").toLowerCase();
  if (text.includes("missing_scope") || text.includes("sharing.read")) {
    return "The Dropbox app needs the sharing.read permission, then the refresh token must be recreated.";
  }
  if (text.includes("shared_link")) {
    return "The shared link route failed. For no-download PDFs, use the file path or file ID inside the authorized Dropbox account.";
  }
  if (text.includes("not_found") || text.includes("path/not_found")) {
    return "Dropbox could not find this file through the current app access. Check that the app was authorized against the Dropbox account that owns the PDF.";
  }
  return "Use the Dropbox error details to decide the next setup step.";
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new HttpError(400, `${label} must be a positive whole number`);
  }
  return number;
}

function isTruthy(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "yes";
}

function publicPayload(payload) {
  return {
    s: payload.s,
    e: payload.e,
    d: payload.d,
    c: payload.c,
    exp: payload.exp || null,
  };
}

function requireStaffPassword(request, env) {
  const url = new URL(request.url);
  requireStaffPasswordValue(url.searchParams.get("password"), env);
}

function requireStaffPasswordValue(password, env) {
  requireEnv(env, "STAFF_PASSWORD");
  if (!password || password !== env.STAFF_PASSWORD) {
    throw new HttpError(401, "Unauthorized");
  }
}

function requireEnv(env, key) {
  if (!env[key]) {
    throw new HttpError(500, `Missing ${key} secret`);
  }
}

async function signToken(payload, env) {
  requireEnv(env, "TOKEN_SECRET");
  const tokenPayload = { ...payload };
  if (tokenPayload.dbx) {
    tokenPayload.p = await encryptPrivatePayload({ dbx: tokenPayload.dbx }, env);
    delete tokenPayload.dbx;
  }
  const encodedPayload = base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(tokenPayload)));
  const signature = await hmacSign(encodedPayload, env.TOKEN_SECRET);
  return `${encodedPayload}.${base64UrlEncodeBytes(signature)}`;
}

async function verifyToken(token, env) {
  requireEnv(env, "TOKEN_SECRET");

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HttpError(401, "Invalid token");
  }

  let provided;
  try {
    provided = base64UrlDecodeToBytes(parts[1]);
  } catch {
    throw new HttpError(401, "Invalid token signature");
  }
  const verified = await hmacVerify(parts[0], env.TOKEN_SECRET, provided);
  if (!verified) {
    throw new HttpError(401, "Invalid token signature");
  }

  let payload;
  try {
    const payloadText = new TextDecoder().decode(base64UrlDecodeToBytes(parts[0]));
    payload = JSON.parse(payloadText);
  } catch {
    throw new HttpError(401, "Invalid token payload");
  }
  parsePositiveInteger(payload.s, "start");
  parsePositiveInteger(payload.e, "end");
  if (payload.p) {
    const privatePayload = await decryptPrivatePayload(payload.p, env);
    payload.dbx = privatePayload.dbx;
  }
  payload.dbx = normalizeDropboxRef(payload.dbx);
  return payload;
}

async function encryptPrivatePayload(payload, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(env.TOKEN_SECRET);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return base64UrlEncodeBytes(combined);
}

async function decryptPrivatePayload(value, env) {
  try {
    const combined = base64UrlDecodeToBytes(value);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await aesKey(env.TOKEN_SECRET);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new HttpError(401, "Invalid private token payload");
  }
}

async function aesKey(secret) {
  const secretHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", secretHash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function hmacVerify(message, secret, providedSignature) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, providedSignature, new TextEncoder().encode(message));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToBytes(value) {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function copyHeader(from, to, name) {
  const value = from.get(name);
  if (value) {
    to.set(name, value);
  }
}

function json(body, request, env, status = 200) {
  const headers = corsHeaders(request, env);
  for (const [key, value] of Object.entries(JSON_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigins = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

  const origin = requestOrigin && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0] || "*";

  return new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
    "access-control-allow-headers": "content-type,range",
    "access-control-expose-headers": "accept-ranges,content-length,content-range,content-type,etag,last-modified,x-dtl-restriction-mode",
    vary: "Origin",
  });
}
