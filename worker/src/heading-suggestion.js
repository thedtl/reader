const GEMINI_GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export async function handleSuggestHeading(request, env, helpers) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return helpers.json({ error: "Invalid JSON body" }, request, env, 400);
  }

  helpers.requireStaffPasswordValue(body.password, env);

  const lines = normalizeHeadingLines(body.lines);
  const images = normalizeHeadingImages(body.images);
  if (lines.length === 0 && images.length === 0) {
    return helpers.json({
      heading: "",
      source: "none",
      note: "No usable front-matter text was provided.",
    }, request, env);
  }

  if (env.GEMINI_API_KEY) {
    const aiHeading = await suggestHeadingWithGemini(lines, images, env).catch(error => {
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
      : images.length > 0
        ? "This PDF may be scanned. Add a GEMINI_API_KEY Worker secret to read title-page images."
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

function normalizeHeadingImages(rawImages) {
  if (!Array.isArray(rawImages)) {
    return [];
  }

  return rawImages
    .slice(0, 8)
    .map(image => {
      if (!image || typeof image !== "object") {
        return null;
      }

      const mimeType = String(image.mimeType || "image/jpeg").toLowerCase();
      const data = String(image.data || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
      if (!/^image\/(jpeg|png|webp)$/.test(mimeType) || !/^[A-Za-z0-9+/=]+$/.test(data)) {
        return null;
      }
      return { mimeType, data };
    })
    .filter(Boolean);
}

async function suggestHeadingWithGemini(lines, images, env) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const excerpts = lines
    .slice(0, 80)
    .map(line => `p${line.pageNumber || "?"}: ${line.text}`)
    .join("\n");

  const prompt = [
    "You are helping library staff create a full bibliographic heading for chapter links.",
    "Use only the provided front-matter text and page images. Do not invent facts.",
    "Hallucination guardrail: every non-empty field must be supported by exact visible words in the text or images.",
    "For each non-empty field, put the exact supporting visible words in visibleEvidence using the same field name.",
    "If a field is likely but not explicitly visible, leave that field blank. Do not fill gaps from general knowledge, catalogs, memory, or assumptions.",
    "Extract separate bibliographic fields first, then create one Chicago Manual of Style bibliography-style entry for the whole book or source.",
    "Use this final style when the facts are visible: Last Name, First Name. Title: Subtitle. Responsibility statement. Series Title, volume/number. City: Publisher, Year.",
    "For multiple authors, include them in Chicago bibliography order. For editors with no author, use ed. or eds. in the contributor field.",
    "Never omit named title-page contributors. If the title page says a person supplied introduction, bibliography, translation, notes, commentary, edition, Latin text, or similar work, capture that as responsibilityStatement and include it after the title.",
    "For French title-page statements such as 'TEXTE LATIN / INTRODUCTION, BIBLIOGRAPHIE / TRADUCTION ET NOTES / par / René Roques', include: Texte latin, introduction, bibliographie, traduction et notes par René Roques.",
    "Extract series title and series volume/number when they are clearly visible, especially for commentary series or multi-volume sets.",
    "Look for publication facts on copyright/title-page verso pages: publisher name, publication place, and publication year.",
    "When city, publisher, and year are visible, the entry must end with City: Publisher, Year.",
    "Do not treat the series title as a substitute for publisher information; include both when both are visible.",
    "Include volume, translator, edition, revision/reprint, or editor details only when they are clearly visible and bibliographically important.",
    "If place, publisher, or year are not visible, omit only the missing pieces instead of inventing them.",
    "Ignore ISBN, copyright boilerplate, library-cataloging blocks, table-of-contents lines, and chapter-title lines.",
    "Return JSON only, with this shape: {\"contributor\":\"...\",\"title\":\"...\",\"responsibilityStatement\":\"...\",\"series\":\"...\",\"seriesNumber\":\"...\",\"edition\":\"...\",\"city\":\"...\",\"publisher\":\"...\",\"year\":\"...\",\"heading\":\"...\",\"visibleEvidence\":{\"contributor\":\"...\",\"title\":\"...\",\"responsibilityStatement\":\"...\",\"series\":\"...\",\"seriesNumber\":\"...\",\"edition\":\"...\",\"city\":\"...\",\"publisher\":\"...\",\"year\":\"...\",\"heading\":\"...\"},\"warnings\":[\"...\"]}.",
    "",
    excerpts || "No selectable text was extracted. Read the attached front-matter page images.",
  ].join("\n");

  const parts = [{ text: prompt }];
  for (const image of images) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.data,
      },
    });
  }

  const response = await fetch(`${GEMINI_GENERATE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts,
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
  return buildAiCitation(parsed);
}

function buildAiCitation(parsed) {
  const evidence = normalizeEvidenceMap(parsed.visibleEvidence || parsed.evidence || {});
  const contributor = supportedAiField(parsed, evidence, "contributor");
  const title = supportedAiField(parsed, evidence, "title");
  const responsibilityStatement = supportedAiField(parsed, evidence, "responsibilityStatement", ["responsibility"]);
  const series = supportedAiField(parsed, evidence, "series");
  const seriesNumber = supportedAiField(parsed, evidence, "seriesNumber");
  const edition = supportedAiField(parsed, evidence, "edition");
  const city = supportedAiField(parsed, evidence, "city");
  const publisher = supportedAiField(parsed, evidence, "publisher");
  const year = supportedAiField(parsed, evidence, "year");
  const fallbackHeading = supportedAiField(parsed, evidence, "heading");

  const parts = [];
  if (contributor) {
    parts.push(trimTerminalPeriod(contributor));
  }
  if (title) {
    parts.push(trimTerminalPeriod(title));
  }
  if (responsibilityStatement) {
    parts.push(trimTerminalPeriod(responsibilityStatement));
  }
  if (series || seriesNumber) {
    parts.push(trimTerminalPeriod([series, seriesNumber].filter(Boolean).join(", ")));
  }
  if (edition) {
    parts.push(trimTerminalPeriod(edition));
  }

  let citation = parts.length > 0
    ? parts.join(". ") + "."
    : fallbackHeading;

  const publication = buildPublicationBlock(city, publisher, year);
  if (publication && !citationIncludesPublication(citation, publication)) {
    citation = `${trimTerminalPeriod(citation)}. ${publication}.`;
  }

  return cleanCitationText(citation);
}

function supportedAiField(parsed, evidence, key, aliases = []) {
  const value = cleanCitationText([key, ...aliases].map(name => parsed[name]).find(Boolean) || "");
  if (!value) {
    return "";
  }

  const evidenceText = [key, ...aliases]
    .map(name => evidence[name])
    .find(Boolean);
  if (evidenceText) {
    return value;
  }

  console.warn("Dropped AI citation field without visible evidence", { field: key });
  return "";
}

function normalizeEvidenceMap(rawEvidence) {
  if (!rawEvidence || typeof rawEvidence !== "object") {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(rawEvidence)) {
    const evidenceText = Array.isArray(value)
      ? value.map(item => cleanCitationText(item)).filter(Boolean).join(" | ")
      : cleanCitationText(value || "");
    if (evidenceText) {
      normalized[key] = evidenceText;
    }
  }
  return normalized;
}

function buildPublicationBlock(city, publisher, year) {
  if (city && publisher && year) {
    return `${city}: ${publisher}, ${year}`;
  }
  if (city && publisher) {
    return `${city}: ${publisher}`;
  }
  if (publisher && year) {
    return `${publisher}, ${year}`;
  }
  return publisher || year || city || "";
}

function citationIncludesPublication(citation, publication) {
  return citation.toLowerCase().includes(publication.toLowerCase());
}

function trimTerminalPeriod(text) {
  return String(text || "").replace(/[.\s]+$/g, "").trim();
}

function buildHeadingSuggestion(lines) {
  const title = chooseTitleLine(lines);
  const author = title ? chooseAuthorLine(lines, title.index) : "";
  const responsibility = title ? chooseResponsibilityStatement(lines, title.index) : "";
  const titleText = title ? collectTitleText(lines, title) : "";

  const parts = [];
  if (author) {
    parts.push(trimTerminalPeriod(author));
  }
  if (title) {
    parts.push(trimTerminalPeriod(titleText));
  }
  if (responsibility) {
    parts.push(trimTerminalPeriod(responsibility));
  }

  if (parts.length > 0) {
    return cleanCitationText(parts.join(". ") + ".");
  }

  return cleanCitationText(title?.text || lines[0]?.text || "");
}

function chooseTitleLine(lines) {
  const maxFontSize = Math.max(...lines.map(line => line.fontSize || 0));
  const scored = lines.map(line => ({
    ...line,
    score: scoreTitleCandidate(line, maxFontSize),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score > 0 ? scored[0] : null;
}

function collectTitleText(lines, title) {
  const titleLines = [title];
  collectAdjacentTitleLines(lines, title, -1)
    .reverse()
    .forEach(line => titleLines.unshift(line));
  collectAdjacentTitleLines(lines, title, 1)
    .forEach(line => titleLines.push(line));

  return cleanCitationText(titleLines.map(line => line.text).join(" "));
}

function collectAdjacentTitleLines(lines, title, direction) {
  const titleLines = [];
  let nextIndex = title.index + direction;

  while (titleLines.length < 3) {
    const next = lines.find(line => line.index === nextIndex);
    if (!next || !isTitleContinuationLine(next, title)) {
      break;
    }

    titleLines.push(next);
    nextIndex += direction;
  }

  return titleLines;
}

function isTitleContinuationLine(line, title) {
  const text = cleanFrontMatterLine(line.text);
  const wordCount = text.split(/\s+/).length;
  if (!text || wordCount > 9) return false;
  if (line.pageNumber !== title.pageNumber) return false;
  if (title.fontSize && line.fontSize && line.fontSize < title.fontSize * 0.72) return false;
  if (/^(by|par)$/i.test(text)) return false;
  if (looksLikeSeriesLine(text)) return false;
  if (looksLikeResponsibilityRoleLine(text)) return false;
  if (looksLikeAuthorLine(text) && !(isMostlyAllCaps(text) && title.fontSize && line.fontSize >= title.fontSize * 0.72)) return false;
  return scoreTitleCandidate(line) > 0;
}

function chooseAuthorLine(lines, titleIndex) {
  const authorBeforeTitle = lines
    .filter(line => (
      line.index < titleIndex &&
      line.index >= titleIndex - 6 &&
      looksLikeAuthorLine(line.text) &&
      !looksLikeSeriesLine(line.text)
    ))
    .sort((a, b) => b.index - a.index);

  if (authorBeforeTitle.length > 0) {
    return cleanAuthorLine(authorBeforeTitle[0].text);
  }

  const authorWindow = lines.filter(line => (
    line.index > titleIndex &&
    line.index <= titleIndex + 6 &&
    looksLikeAuthorLine(line.text)
  ));

  return authorWindow.length ? cleanAuthorLine(authorWindow[0].text) : "";
}

function chooseResponsibilityStatement(lines, titleIndex) {
  const window = lines.filter(line => (
    line.index > titleIndex &&
    line.index <= titleIndex + 18
  ));

  const direct = window.find(line => looksLikeDirectResponsibilityLine(line.text));
  if (direct) {
    return normalizeResponsibilityStatement(direct.text);
  }

  const byIndex = window.findIndex(line => /^(by|par)$/i.test(cleanFrontMatterLine(line.text)));
  if (byIndex <= 0 || byIndex >= window.length - 1) {
    return "";
  }

  const roleLines = window
    .slice(Math.max(0, byIndex - 6), byIndex)
    .filter(line => looksLikeResponsibilityRoleLine(line.text))
    .map(line => line.text);
  const name = normalizeContributorName(window[byIndex + 1].text);

  if (roleLines.length === 0 || !looksLikeContributorName(name)) {
    return "";
  }

  const connector = /^par$/i.test(cleanFrontMatterLine(window[byIndex].text)) ? "par" : "by";
  return cleanCitationText(`${formatResponsibilityRoles(roleLines)} ${connector} ${name}`);
}

function scoreTitleCandidate(line, maxFontSize = 0) {
  const text = line.text;
  const wordCount = text.split(/\s+/).length;
  let score = 0;

  if (line.pageNumber <= 3) score += 4;
  if (wordCount >= 2 && wordCount <= 14) score += 4;
  if (line.fontSize >= 12) score += 2;
  if (maxFontSize && line.fontSize && line.fontSize < maxFontSize * 0.72) score -= 5;
  if (maxFontSize && line.fontSize && line.fontSize >= maxFontSize * 0.9) score += 3;
  if (/^[A-Z0-9][A-Za-z0-9'":;,.& -]+$/.test(text)) score += 2;
  if (/[a-z]/.test(text) && /[A-Z]/.test(text)) score += 1;
  if (/^(edited by|translated by|by|chapter|contents|table of contents)\b/i.test(text)) score -= 5;
  if (/^(by|par)$/i.test(text)) score -= 8;
  if (looksLikeSeriesLine(text)) score -= 7;
  if (looksLikeResponsibilityRoleLine(text)) score -= 8;
  if (looksLikeAuthorLine(text) && !(isMostlyAllCaps(text) && maxFontSize && line.fontSize >= maxFontSize * 0.9)) score -= 5;
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

  const capitalizedWords = words.filter(word => /^\p{Lu}[\p{L}'.-]+$/u.test(word));
  return capitalizedWords.length >= Math.min(2, words.length);
}

function looksLikeSeriesLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /^(sources?\s+chr[ée]tiennes?|n[°o]\s*\d+|series|volume|vol\.?)\b/i.test(cleaned);
}

function looksLikeDirectResponsibilityLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /\b(translated|translation|edited|editor|introduction|introduced|bibliography|bibliographie|notes?|commentary|latin text|texte latin|traduction|traduit|preface|préface|foreword|annotated|annotations?)\b/i.test(cleaned) &&
    /\b(by|par)\b/i.test(cleaned);
}

function looksLikeResponsibilityRoleLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /\b(translated|translation|edited|editor|introduction|introduced|bibliography|bibliographie|notes?|commentary|latin text|texte latin|traduction|traduit|preface|préface|foreword|annotated|annotations?)\b/i.test(cleaned);
}

function normalizeResponsibilityStatement(text) {
  const cleaned = cleanCitationText(text);
  const match = cleaned.match(/^(.*?)\b(by|par)\b\s+(.+)$/i);
  if (!match) {
    return sentenceCaseText(cleaned);
  }

  const role = sentenceCaseText(match[1]);
  const connector = /^par$/i.test(match[2]) ? "par" : "by";
  const name = normalizeContributorName(match[3]);
  return cleanCitationText(`${role} ${connector} ${name}`);
}

function formatResponsibilityRoles(lines) {
  return sentenceCaseText(cleanCitationText(lines.join(", ")));
}

function normalizeContributorName(text) {
  return cleanCitationText(text)
    .replace(/[.,;:]+$/g, "")
    .replace(/\b[\p{L}'’-]+\b/gu, word => (
      word.length > 1 && word === word.toLocaleUpperCase("fr")
        ? word.charAt(0).toLocaleUpperCase("fr") + word.slice(1).toLocaleLowerCase("fr")
        : word
    ));
}

function looksLikeContributorName(text) {
  const cleaned = cleanCitationText(text);
  if (!cleaned || cleaned.length > 80) return false;
  if (/[0-9]/.test(cleaned)) return false;
  if (/\b(directeur|director|professor|universit|école|school|press|publisher)\b/i.test(cleaned)) return false;
  return cleaned.split(/\s+/).length >= 2;
}

function sentenceCaseText(text) {
  const cleaned = cleanCitationText(text).toLocaleLowerCase("fr");
  return cleaned ? cleaned.charAt(0).toLocaleUpperCase("fr") + cleaned.slice(1) : "";
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
