const GEMINI_GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export async function handleSuggestHeading(request, env, helpers) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return helpers.json({ error: "Invalid JSON body" }, request, env, 400);
  }

  helpers.requireStaffPasswordValue(body.password, env);

  const lines = normalizeHeadingLines(body.lines);
  if (lines.length === 0) {
    return helpers.json({
      heading: "",
      source: "none",
      note: "No usable front-matter text was provided.",
    }, request, env);
  }

  if (env.GEMINI_API_KEY) {
    const aiHeading = await suggestHeadingWithGemini(lines, env).catch(error => {
      console.warn("Gemini heading suggestion failed", {
        message: error.message || String(error),
      });
      return "";
    });

    if (aiHeading) {
      return helpers.json({
        heading: aiHeading,
        source: "ai",
        note: "Review before generating links.",
      }, request, env);
    }
  }

  return helpers.json({
    heading: buildHeadingSuggestion(lines),
    source: "heuristic",
    note: env.GEMINI_API_KEY
      ? "AI did not return a usable heading, so the Worker used the local fallback."
      : "No AI key is configured, so the Worker used the local fallback.",
  }, request, env);
}

function normalizeHeadingLines(rawLines) {
  if (!Array.isArray(rawLines)) {
    return [];
  }

  return rawLines
    .slice(0, 160)
    .map((line, index) => {
      if (typeof line === "string") {
        return { text: cleanFrontMatterLine(line), index };
      }
      if (line && typeof line === "object") {
        return {
          text: cleanFrontMatterLine(line.text),
          pageNumber: Number(line.pageNumber || 0),
          fontSize: Number(line.fontSize || 0),
          index,
        };
      }
      return { text: "", index };
    })
    .filter(line => isUsefulFrontMatterLine(line.text));
}

async function suggestHeadingWithGemini(lines, env) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const excerpts = lines
    .slice(0, 80)
    .map(line => `p${line.pageNumber || "?"}: ${line.text}`)
    .join("\n");

  const prompt = [
    "You are helping library staff create a concise bibliographic heading for chapter links.",
    "Use only the provided front-matter text. Do not invent facts.",
    "Return one editable heading in this style when possible: Author Last Name, Book Title.",
    "If there is a subtitle, include it only when it clearly belongs to the book title.",
    "Ignore copyright, ISBN, publisher-address, library-cataloging, table-of-contents, and chapter-title lines.",
    "If an editor is clearly the main responsible person and no author is visible, use Editor Name, ed., Book Title.",
    "Return JSON only, with this shape: {\"heading\":\"...\"}.",
    "",
    excerpts,
  ].join("\n");

  const response = await fetch(`${GEMINI_GENERATE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini heading suggestion failed: ${text.slice(0, 300)}`);
  }

  const data = JSON.parse(text || "{}");
  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = JSON.parse(responseText || "{}");
  return cleanCitationText(parsed.heading || "");
}

function buildHeadingSuggestion(lines) {
  const title = chooseTitleLine(lines);
  const author = title ? chooseAuthorLine(lines, title.index) : "";

  if (author && title) {
    return cleanCitationText(`${author}, ${title.text}`);
  }

  return cleanCitationText(title?.text || lines[0]?.text || "");
}

function chooseTitleLine(lines) {
  const scored = lines.map(line => ({
    ...line,
    score: scoreTitleCandidate(line),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score > 0 ? scored[0] : null;
}

function chooseAuthorLine(lines, titleIndex) {
  const authorWindow = lines.filter(line => (
    line.index > titleIndex &&
    line.index <= titleIndex + 6 &&
    looksLikeAuthorLine(line.text)
  ));

  return authorWindow.length ? cleanAuthorLine(authorWindow[0].text) : "";
}

function scoreTitleCandidate(line) {
  const text = line.text;
  const wordCount = text.split(/\s+/).length;
  let score = 0;

  if (line.pageNumber <= 3) score += 4;
  if (wordCount >= 2 && wordCount <= 14) score += 4;
  if (line.fontSize >= 12) score += 2;
  if (/^[A-Z0-9][A-Za-z0-9'":;,.& -]+$/.test(text)) score += 2;
  if (/[a-z]/.test(text) && /[A-Z]/.test(text)) score += 1;
  if (/^(edited by|translated by|by|chapter|contents|table of contents)\b/i.test(text)) score -= 5;
  if (looksLikeAuthorLine(text)) score -= 2;
  if (isMostlyAllCaps(text) && wordCount <= 3) score -= 1;

  return score;
}

function looksLikeAuthorLine(text) {
  const cleaned = cleanAuthorLine(text);
  if (!cleaned) return false;
  if (/^(edited|translated|compiled|introduction|foreword|preface)\b/i.test(cleaned)) return false;

  const words = cleaned.split(/\s+/);
  if (words.length < 2 || words.length > 8) return false;
  if (/[0-9]/.test(cleaned)) return false;
  if (/[.:;]/.test(cleaned)) return false;

  const capitalizedWords = words.filter(word => /^[A-Z][A-Za-z'.-]+$/.test(word));
  return capitalizedWords.length >= Math.min(2, words.length);
}

function isUsefulFrontMatterLine(text) {
  if (!text || text.length < 3 || text.length > 140) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^(copyright|all rights reserved|printed in|library of congress|isbn|issn|doi|www\.|http|publisher|published by|contents|table of contents)$/i.test(text)) return false;
  if (/(copyright|all rights reserved|library of congress|isbn|issn|cataloging|cataloguing|manufactured in|printed in|permission|rights reserved)/i.test(text)) return false;
  if (/^[.\-_/\\|]+$/.test(text)) return false;
  return true;
}

function cleanFrontMatterLine(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([(["'])\s+/g, "$1")
    .replace(/\s+([)\]"'])/g, "$1")
    .trim();
}

function cleanAuthorLine(text) {
  return cleanFrontMatterLine(text)
    .replace(/^by\s+/i, "")
    .replace(/^author\s*:\s*/i, "")
    .trim();
}

function cleanCitationText(text) {
  return cleanFrontMatterLine(text)
    .replace(/\s*,\s*,/g, ",")
    .replace(/\s+,\s+/g, ", ")
    .trim();
}

function isMostlyAllCaps(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return false;
  const uppercase = letters.replace(/[^A-Z]/g, "").length;
  return uppercase / letters.length > 0.85;
}
