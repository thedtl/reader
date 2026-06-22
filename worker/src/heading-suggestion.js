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
    .filter(line => line.text);
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
    "For a personal author shown as First Name Last Name, invert the author in the final bibliography heading as Last Name, First Name.",
    "Use the author name exactly as it appears on the title page. Do not expand, correct, or formalize it from copyright text; for example, if the title page says Tim Arnold and the copyright page says Timothy Arnold, use Tim Arnold.",
    "For multiple authors, include them in Chicago bibliography order. For editors with no author, use ed. or eds. in the contributor field.",
    "Never omit named title-page contributors. If the title page says a person supplied introduction, bibliography, translation, notes, commentary, edition, Latin text, or similar work, capture that as responsibilityStatement and include it after the title.",
    "For French title-page statements such as 'TEXTE LATIN / INTRODUCTION, BIBLIOGRAPHIE / TRADUCTION ET NOTES / par / René Roques', include: Texte latin, introduction, bibliographie, traduction et notes par René Roques.",
    "Extract series title and series volume/number when they are clearly visible, especially for commentary series or multi-volume sets.",
    "Look for publication facts on copyright/title-page verso pages: publisher name, publication place, and publication year.",
    "CMOS 18 no longer requires publication place, but this tool should include a visible place when it is clearly identified in the front matter.",
    "When city, publisher, and year are clearly visible, the entry may end with City: Publisher, Year; otherwise use Publisher, Year.",
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
  return buildAiCitation(parsed, lines);
}

function buildAiCitation(parsed, lines = []) {
  const evidence = normalizeEvidenceMap(parsed.visibleEvidence || parsed.evidence || {});
  const contributor = preferTitlePageContributor(supportedAiField(parsed, evidence, "contributor"), lines);
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
    parts.push(trimTerminalPeriod(formatChicagoBibliographyAuthors(contributor)));
  }
  if (title) {
    parts.push(trimTerminalPeriod(formatCitationTitle(title)));
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

function trimAuthorName(text) {
  return cleanFrontMatterLine(text).replace(/[,;:]+$/g, "");
}

function punctuateAuthorList(text) {
  const cleaned = cleanCitationText(text);
  return /[.!?]$/.test(cleaned) ? cleaned : cleaned + ".";
}

function punctuateCitationPart(text) {
  const cleaned = cleanCitationText(text);
  return /[.!?]$/.test(cleaned) ? cleaned : cleaned + ".";
}

function formatCitationTitle(title) {
  const cleaned = trimTerminalPeriod(title);
  return cleanCitationText(cleaned.replace(/\b[\p{Lu}][\p{Lu}'’-]{2,}\b/gu, word => {
    if (/^(II|III|IV|IX|VI|VII|VIII|USA|UK|US|PDF|ISBN)$/u.test(word)) return word;
    return word.charAt(0).toLocaleUpperCase("en") + word.slice(1).toLocaleLowerCase("en");
  }));
}

function preferTitlePageContributor(aiContributor, lines) {
  const titlePageAuthor = findTitlePageAuthor(lines);
  if (!titlePageAuthor) {
    return aiContributor;
  }

  if (!aiContributor) {
    return titlePageAuthor;
  }

  if (sameNormalizedName(aiContributor, titlePageAuthor)) {
    return aiContributor;
  }

  if (sameLastName(aiContributor, titlePageAuthor)) {
    return titlePageAuthor;
  }

  return aiContributor;
}

function findTitlePageAuthor(lines) {
  const candidates = lines.filter(line => isUsefulFrontMatterLine(line.text));
  const title = chooseTitleLine(candidates);
  const author = title ? chooseAuthorLine(candidates, title.index) : "";
  return author ? normalizeContributorName(author) : "";
}

function sameNormalizedName(a, b) {
  return normalizeNameForComparison(a) === normalizeNameForComparison(b);
}

function sameLastName(a, b) {
  const aLast = comparableLastName(a);
  const bLast = comparableLastName(b);
  return aLast && bLast && aLast === bLast;
}

function comparableLastName(name) {
  const cleaned = cleanAuthorLine(name);
  if (!cleaned) return "";

  if (cleaned.includes(",")) {
    return normalizeNameForComparison(cleaned.split(",")[0]);
  }

  const parts = normalizeNameForComparison(cleaned).split(" ").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : "";
}

function normalizeNameForComparison(name) {
  return cleanAuthorLine(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en")
    .trim();
}

function formatChicagoBibliographyAuthors(author) {
  const cleaned = cleanAuthorLine(author);
  if (!cleaned) return "";

  const names = splitAuthorNames(cleaned)
    .map(name => normalizeContributorName(name))
    .filter(Boolean);

  if (names.length === 0) return "";

  if (names.length === 1) {
    return punctuateAuthorList(trimAuthorName(invertPersonalName(names[0])));
  }

  const first = trimAuthorName(invertPersonalName(names[0]));
  const rest = names.slice(1).map(name => trimAuthorName(name));

  let authorList = "";
  if (rest.length === 1) {
    authorList = first + ", and " + rest[0];
  } else {
    authorList = first + ", " + rest.slice(0, -1).join(", ") + ", and " + rest[rest.length - 1];
  }

  return punctuateAuthorList(authorList);
}

function splitAuthorNames(authorText) {
  const cleaned = cleanAuthorLine(authorText);
  if (!cleaned) return [];

  const pieces = cleaned
    .replace(/\s+(?:and|&)\s+/gi, ", ")
    .split(/\s*,\s*/)
    .map(piece => trimAuthorName(piece))
    .filter(Boolean);

  if (pieces.length <= 1) return pieces;

  const names = [];
  let index = 0;
  if (pieces.length >= 2 && looksLikeInvertedAuthorPieces(pieces[0], pieces[1])) {
    names.push(`${pieces[0]}, ${pieces[1]}`);
    index = 2;
  }

  for (; index < pieces.length; index++) {
    names.push(pieces[index]);
  }

  return names;
}

function looksLikeInvertedAuthorPieces(lastName, givenNames) {
  const last = cleanFrontMatterLine(lastName);
  const given = cleanFrontMatterLine(givenNames);
  if (!last || !given || /[.;:]/.test(last)) return false;
  if (!looksLikeSurnamePiece(last)) return false;
  return given.split(/\s+/).filter(Boolean).length <= 4;
}

function looksLikeSurnamePiece(text) {
  const words = cleanFrontMatterLine(text).split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  if (words.some(word => /\.$/.test(word))) return false;
  if (words.length === 1) return /^\p{Lu}/u.test(words[0]);
  return words.slice(0, -1).every(word => /^\p{Ll}/u.test(word)) && /^\p{Lu}/u.test(words[words.length - 1]);
}

function looksLikePersonalName(name) {
  const cleaned = cleanAuthorLine(name);
  if (!cleaned || /[0-9;:]/.test(cleaned)) return false;
  const words = cleaned.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  const nameWords = words.filter(word => /^(\p{Lu}[\p{L}'’-]*\.?|[A-Z]\.)$/u.test(word) || /^\p{Ll}{1,3}$/u.test(word));
  const capitalizedWords = words.filter(word => /^(\p{Lu}[\p{L}'’-]*\.?|[A-Z]\.)$/u.test(word));
  return nameWords.length === words.length && capitalizedWords.length >= 2;
}

function invertPersonalName(name) {
  const cleaned = trimAuthorName(name);
  if (!cleaned || cleaned.includes(",")) return cleaned;

  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) return cleaned;

  const suffixes = ["Jr.", "Jr", "Sr.", "Sr", "II", "III", "IV", "V"];
  let suffix = "";
  if (suffixes.includes(parts[parts.length - 1])) {
    suffix = parts.pop();
  }

  const last = parts.pop();
  const given = parts.join(" ");
  return last + ", " + given + (suffix ? ", " + suffix : "");
}

function buildHeadingSuggestion(lines) {
  const candidates = lines.filter(line => isUsefulFrontMatterLine(line.text));
  const title = chooseTitleLine(candidates);
  const author = title ? chooseAuthorLine(candidates, title.index) : "";
  const responsibility = title ? chooseResponsibilityStatement(candidates, title.index) : "";
  const series = title ? chooseSeriesStatement(candidates, title.index) : "";
  const edition = title ? chooseEditionStatement(candidates, title.index) : "";
  const publication = choosePublicationStatement(lines);
  const titleText = title ? collectTitleText(lines, title) : "";

  const parts = [];
  if (author) {
    parts.push(formatChicagoBibliographyAuthors(author));
  }
  if (title) {
    parts.push(titleText);
  }
  if (responsibility) {
    parts.push(responsibility);
  }
  if (series) {
    parts.push(series);
  }
  if (edition) {
    parts.push(edition);
  }
  if (publication) {
    parts.push(publication);
  }

  if (parts.length > 0) {
    return cleanCitationText(parts.map(punctuateCitationPart).join(" "));
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

  const subtitleIndex = titleLines.findIndex((line, index) => index > 0 && looksLikeSubtitleLine(line.text));
  if (subtitleIndex > 0) {
    const mainTitle = formatCitationTitle(titleLines.slice(0, subtitleIndex).map(line => line.text).join(" "));
    const subtitle = formatCitationTitle(titleLines.slice(subtitleIndex).map(line => line.text).join(" "));
    return cleanCitationText(`${mainTitle}: ${subtitle}`);
  }

  return formatCitationTitle(titleLines.map(line => line.text).join(" "));
}

function collectAdjacentTitleLines(lines, title, direction) {
  const titleLines = [];
  let nextIndex = title.index + direction;

  while (titleLines.length < 3) {
    const next = lines.find(line => line.index === nextIndex);
    if (!next || !isTitleContinuationLine(next, title, direction)) {
      break;
    }

    titleLines.push(next);
    nextIndex += direction;
  }

  return titleLines;
}

function isTitleContinuationLine(line, title, direction = 1) {
  const text = cleanFrontMatterLine(line.text);
  const wordCount = text.split(/\s+/).length;
  if (!text || wordCount > 9) return false;
  if (line.pageNumber !== title.pageNumber) return false;
  if (title.fontSize && line.fontSize && line.fontSize < title.fontSize * 0.72) {
    if (!(direction > 0 && line.fontSize >= title.fontSize * 0.45 && looksLikeSubtitleLine(text))) {
      return false;
    }
  }
  if (/^(by|par)$/i.test(text)) return false;
  if (looksLikeSeriesLine(text)) return false;
  if (looksLikeEditionLine(text)) return false;
  if (looksLikeResponsibilityRoleLine(text)) return false;
  if (looksLikeSubtitleLine(text)) return true;
  if (looksLikeAuthorLine(text) && !(isMostlyAllCaps(text) && title.fontSize && line.fontSize >= title.fontSize * 0.72)) return false;
  return scoreTitleCandidate(line) > 0;
}

function chooseAuthorLine(lines, titleIndex) {
  const title = lines.find(line => line.index === titleIndex);
  const titleLineIndexes = getTitleLineIndexes(lines, title);
  const authorBeforeTitle = lines
    .filter(line => (
      line.index < titleIndex &&
      line.index >= titleIndex - 6 &&
      !titleLineIndexes.has(line.index) &&
      looksLikeAuthorLine(line.text) &&
      !looksLikeSeriesLine(line.text)
    ))
    .sort((a, b) => b.index - a.index);

  if (authorBeforeTitle.length > 0) {
    return collectAuthorText(lines, authorBeforeTitle[0]);
  }

  const authorWindow = lines.filter(line => (
    line.index > titleIndex &&
    line.index <= titleIndex + 6 &&
    !titleLineIndexes.has(line.index) &&
    looksLikeAuthorLine(line.text)
  ));

  return authorWindow.length ? collectAuthorText(lines, authorWindow[0]) : "";
}

function getTitleLineIndexes(lines, title) {
  if (!title) return new Set();
  return new Set([
    title.index,
    ...collectAdjacentTitleLines(lines, title, -1).map(line => line.index),
    ...collectAdjacentTitleLines(lines, title, 1).map(line => line.index),
  ]);
}

function collectAuthorText(lines, firstAuthorLine) {
  const authorLines = [firstAuthorLine];
  let nextIndex = firstAuthorLine.index + 1;

  while (authorLines.length < 4) {
    const next = lines.find(line => line.index === nextIndex);
    if (!next || !looksLikeAuthorLine(next.text)) break;
    authorLines.push(next);
    nextIndex += 1;
  }

  return cleanAuthorLine(authorLines.map(line => trimTerminalPeriod(line.text)).join(", "));
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

function chooseSeriesStatement(lines, titleIndex) {
  const window = lines.filter(line => (
    line.index >= titleIndex - 8 &&
    line.index <= titleIndex + 8 &&
    looksLikeSeriesLine(line.text)
  ));
  if (window.length === 0) return "";

  const seriesLine = window.find(line => /\bseries\b|sources?\s+chr[ée]tiennes?/i.test(line.text));
  const numberLine = window.find(line => /^(volume|vol\.?|n[°o]|no\.?)\b/i.test(cleanFrontMatterLine(line.text)));

  if (seriesLine && numberLine && seriesLine !== numberLine) {
    return cleanCitationText(`${formatSeriesLine(seriesLine.text)}, ${formatSeriesLine(numberLine.text)}`);
  }

  return formatSeriesLine((seriesLine || numberLine || window[0]).text);
}

function chooseEditionStatement(lines, titleIndex) {
  const edition = lines.find(line => (
    line.index > titleIndex &&
    line.index <= titleIndex + 10 &&
    looksLikeEditionLine(line.text)
  ));
  return edition ? sentenceCaseText(edition.text) : "";
}

function formatSeriesLine(text) {
  const cleaned = cleanFrontMatterLine(text)
    .replace(/^n[°o]\s*/i, "")
    .replace(/^no\.?\s*/i, "")
    .replace(/^volume\s+/i, "volume ")
    .replace(/^vol\.?\s+/i, "volume ");
  return /^volume\b/i.test(cleaned) || /^\d+$/.test(cleaned)
    ? cleaned.toLocaleLowerCase("en")
    : formatCitationTitle(cleaned);
}

function choosePublicationStatement(lines) {
  const publisherInfo = findPublisherInfo(lines);
  const year = findPublicationYear(lines);
  return buildPublicationBlock(publisherInfo.city, publisherInfo.publisher, year);
}

function findPublicationYear(lines) {
  const yearLine = lines.find(line => /\b(copyright|first printing|published|publication|édition|impression)\b/i.test(line.text) && extractYear(line.text)) ||
    lines.find(line => extractYear(line.text));
  return yearLine ? extractYear(yearLine.text) : "";
}

function extractYear(text) {
  const match = String(text || "").match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return match ? match[1] : "";
}

function findPublisherInfo(lines) {
  let best = { publisher: "", city: "", score: 0 };
  for (const line of lines) {
    const info = parsePublisherLine(line.text);
    if (info.publisher) {
      if (!info.city) {
        const nearbyPlace = lines
          .filter(candidate => candidate.index > line.index && candidate.index <= line.index + 4)
          .map(candidate => findPlaceInText(candidate.text))
          .find(Boolean);
        info.city = nearbyPlace || "";
      }
      const score = scorePublisherInfo(info, line.text);
      if (score > best.score) {
        best = { ...info, score };
      }
    }
  }
  return { publisher: best.publisher, city: best.city };
}

function scorePublisherInfo(info, sourceText) {
  let score = 1;
  if (info.city) score += 3;
  if (/\b(published by|éditions?|press|publisher|publishing|inc\.?|co\.?|company|sarl|sons?|wiley|jossey|bass|guilford|cerf)\b/i.test(sourceText)) score += 2;
  if (/\b(copyright|©)\b/i.test(sourceText)) score += 1;
  if (info.publisher.length > 8) score += 1;
  return score;
}

function parsePublisherLine(text) {
  let cleaned = cleanFrontMatterLine(text);
  if (!cleaned) return { publisher: "", city: "" };

  const publishedBy = cleaned.match(/^published by\s+(.+)$/i);
  if (publishedBy) cleaned = publishedBy[1];

  cleaned = cleaned
    .replace(/^copyright\s*©?\s*(?:\d{4}\s*)?(?:by\s+)?/i, "")
    .replace(/\b\d{4}\b/g, "")
    .replace(/\ball rights reserved\b/ig, "")
    .replace(/\btous droits réservés\b/ig, "")
    .trim();

  if (!looksLikePublisherLine(cleaned)) return { publisher: "", city: "" };

  const dashParts = cleaned.split(/\s+[–-]\s+/).map(part => cleanFrontMatterLine(part)).filter(Boolean);
  if (dashParts.length > 1) {
    return {
      publisher: normalizePublisherName(dashParts[0]),
      city: findPlaceInText(dashParts.slice(1).join(", ")),
    };
  }

  const commaParts = cleaned.split(/\s*,\s*/).map(part => cleanFrontMatterLine(part)).filter(Boolean);
  if (/^published by/i.test(text) && commaParts.length > 1) {
    const publisherPartCount = commaParts.length >= 3 && /\b(inc\.?|co\.?|company|sons?)$/i.test(commaParts[1]) ? 2 : 1;
    return {
      publisher: normalizePublisherName(commaParts.slice(0, publisherPartCount).join(", ")),
      city: findPlaceInText(commaParts.slice(publisherPartCount).join(", ")),
    };
  }

  return {
    publisher: normalizePublisherName(cleaned),
    city: findPlaceInText(cleaned),
  };
}

function looksLikePublisherLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  if (!cleaned || looksLikeResponsibilityRoleLine(cleaned)) return false;
  return /\b(press|publisher|publishers|publishing|university|college|éditions?|editiones|books?|inc\.?|co\.?|company|sarl|sons?|wiley|jossey|bass|guilford|excelsis|leaders for leaders|hana medical|cerf)\b/i.test(cleaned);
}

function normalizePublisherName(text) {
  const cleaned = cleanFrontMatterLine(text)
    .replace(/\s+site internet\b.*$/i, "")
    .replace(/\s+www\..*$/i, "")
    .replace(/\s+all rights reserved.*$/i, "")
    .replace(/[,;:]+$/g, "");
  return /\b(inc|co|ltd|corp)\.$/i.test(cleaned) ? cleaned : cleaned.replace(/\.$/, "");
}

function findPlaceInText(text) {
  const cleaned = cleanFrontMatterLine(text).replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/ig, "");
  const matches = [...cleaned.matchAll(/\b([\p{Lu}][\p{L}' .-]+,\s*(?:[A-Z]{2}|[\p{Lu}][\p{L}' .-]+|France|Korea|New Jersey))\b/gu)];
  for (const match of matches.reverse()) {
    const place = cleanFrontMatterLine(match[1]).replace(/[.,;:]+$/g, "");
    if (!/\b(inc|co|company|sons?|press|publisher|publishing|wiley|jossey|bass)\b/i.test(place)) {
      return place;
    }
  }
  return "";
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
  if (looksLikeEditionLine(text)) score -= 7;
  if (looksLikeResponsibilityRoleLine(text)) score -= 8;
  if (looksLikeAuthorLine(text) && !(isMostlyAllCaps(text) && maxFontSize && line.fontSize >= maxFontSize * 0.9)) score -= 5;
  if (isMostlyAllCaps(text) && wordCount <= 3) score -= 1;

  return score;
}

function looksLikeAuthorLine(text) {
  const cleaned = cleanAuthorLine(text);
  if (!cleaned) return false;
  if (/^(edited|translated|compiled|introduction|foreword|preface)\b/i.test(cleaned)) return false;
  if (looksLikeSeriesLine(cleaned)) return false;
  if (looksLikeEditionLine(cleaned)) return false;

  const words = cleaned.split(/\s+/);
  if (words.length < 2 || words.length > 8) return false;
  if (/^(a|an|and|for|in|of|on|or|the|to|with)\b/i.test(cleaned)) return false;
  if (/[0-9]/.test(cleaned)) return false;
  if (/[;:]/.test(cleaned)) return false;
  if (words.length > 4 && !cleaned.includes(",")) return false;

  return splitAuthorNames(cleaned).some(name => looksLikePersonalName(name));
}

function looksLikeSeriesLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /^(sources?\s+chr[ée]tiennes?|n[°o]\s*\d+|series|volume|vol\.?)\b/i.test(cleaned) ||
    /\bseries\b/i.test(cleaned);
}

function looksLikeEditionLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?|premi[èe]re|deuxi[èe]me|troisi[èe]me)\s+(edition|ed\.?|édition|réimpression)\b/i.test(cleaned) ||
    /\b(edition|ed\.?|édition|réimpression)\b/i.test(cleaned) && cleaned.split(/\s+/).length <= 6;
}

function looksLikeSubtitleLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  if (!cleaned || isMostlyAllCaps(cleaned)) return false;
  if (looksLikeSeriesLine(cleaned)) return false;
  if (looksLikeResponsibilityRoleLine(cleaned)) return false;

  const words = cleaned.split(/\s+/);
  if (words.length < 2 || words.length > 14) return false;

  const hasTitleConnector = /\b(a|an|and|for|from|how|in|of|on|or|the|to|with|why)\b/i.test(cleaned);
  if (looksLikeAuthorLine(cleaned) && !hasTitleConnector) return false;

  return /^(a|an|and|for|from|how|in|of|on|or|the|to|with|why)\b/i.test(cleaned) ||
    hasTitleConnector ||
    (/[a-z]/.test(cleaned) && /[A-Z]/.test(cleaned));
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
    .replace(/\s+(?:지음|저|著)\s*$/u, "")
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
