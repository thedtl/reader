import assert from "node:assert/strict";
import test from "node:test";

import { handleSuggestHeading } from "../src/heading-suggestion.js";

const EXPECTED_BIEREMA_HEADING = "Bierema, Laura L., Monica Fedeli, and Sharan B. Merriam. Adult Learning: Linking Theory and Practice. Second edition. Hoboken, New Jersey: John Wiley & Sons, Inc., 2025.";

const BIEREMA_LINES = [
  { text: "ADULT LEARNING", pageNumber: 1, fontSize: 30 },
  { text: "Linking Theory and Practice", pageNumber: 1, fontSize: 20 },
  { text: "Second Edition", pageNumber: 1, fontSize: 15 },
  { text: "Laura L. Bierema, Monica Fedeli,", pageNumber: 1, fontSize: 14 },
  { text: "Sharan B. Merriam", pageNumber: 1, fontSize: 14 },
  { text: "JOSSEY-BASS", pageNumber: 1, fontSize: 12 },
  { text: "A Wiley Brand", pageNumber: 1, fontSize: 8 },
  { text: "Copyright © 2025 by John Wiley & Sons, Inc. All rights reserved", pageNumber: 2, fontSize: 10 },
  { text: "Published by John Wiley & Sons, Inc., Hoboken, New Jersey", pageNumber: 2, fontSize: 10 },
  { text: "Published simultaneously in Canada.", pageNumber: 2, fontSize: 10 },
  { text: "Names: Bierema, Laura L. (Laura Lee), 1964- author | Fedeli, Monica author | Merriam, Sharan B. author", pageNumber: 2, fontSize: 10 },
  { text: "Title: Adult learning: linking theory and practice / Laura L. Bierema, Monica Fedeli, Sharan B. Merriam.", pageNumber: 2, fontSize: 10 },
  { text: "Description: Second edition. | Hoboken, New Jersey : Jossey-Bass, [2025]", pageNumber: 2, fontSize: 10 },
];

const helpers = {
  requireStaffPasswordValue() {},
  json(data, request, env, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  },
};

async function requestSuggestion({ parsedAiResponse, env = {}, lines = BIEREMA_LINES, images = [] } = {}) {
  const originalFetch = globalThis.fetch;
  let geminiRequestBody = null;
  if (parsedAiResponse) {
    globalThis.fetch = async (url, init) => {
      geminiRequestBody = JSON.parse(init?.body || "{}");
      return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify(parsedAiResponse) }],
        },
      }],
      }), { status: 200 });
    };
  }

  try {
    const request = new Request("https://example.test/suggest-heading", {
      method: "POST",
      body: JSON.stringify({ password: "test", lines, images }),
    });
    const response = await handleSuggestHeading(request, env, helpers);
    return { ...(await response.json()), geminiRequestBody };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("heuristic fallback extracts full Bierema citation", async () => {
  const result = await requestSuggestion();

  assert.equal(result.source, "heuristic");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
});

test("bad AI heading-only citation is rejected in favor of extracted fields", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      heading: "Learning, Adult. Second Edition.",
      visibleEvidence: {
        heading: "ADULT LEARNING Second Edition",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.notEqual(result.heading, "Learning, Adult. Second Edition.");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
});

test("bad AI structured citation is rejected in favor of extracted fields", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      contributor: "Adult Learning",
      title: "Second Edition",
      visibleEvidence: {
        contributor: "ADULT LEARNING",
        title: "Second Edition",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
});

test("complete AI heading-only citation can pass when it includes extracted core facts", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      heading: EXPECTED_BIEREMA_HEADING,
      visibleEvidence: {
        heading: "Laura L. Bierema, Monica Fedeli, Sharan B. Merriam ADULT LEARNING Linking Theory and Practice Second Edition Published by John Wiley & Sons, Inc., Hoboken, New Jersey",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
});

test("AI responsibility text normalizes all-caps names and removes order credentials", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      heading: "Bonaventure, Itinéraire de l'esprit jusqu'en Dieu, Introduction, notes et glossaire par Laure SOLIGNAC, traduction par André MÉNARD ofmcap, Translatio Philosophies Médiévales (Paris: Librairie Philosophique J. Vrin, 2019).",
      visibleEvidence: {
        heading: "Bonaventure Itinéraire de l'esprit jusqu'en Dieu Introduction, notes et glossaire par Laure SOLIGNAC traduction par André MÉNARD ofmcap Translatio Philosophies Médiévales Paris Librairie Philosophique J. Vrin 2019",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.match(result.heading, /Laure Solignac/);
  assert.match(result.heading, /André Ménard/);
  assert.doesNotMatch(result.heading, /SOLIGNAC|MÉNARD/);
  assert.doesNotMatch(result.heading, /ofmcap/i);
});

test("AI structured responsibility field is normalized before citation assembly", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Bonaventure",
      title: "Itinéraire de l'esprit jusqu'en Dieu",
      responsibilityStatement: "Introduction, notes et glossaire par Laure SOLIGNAC, traduction par André MÉNARD ofmcap",
      series: "Translatio Philosophies Médiévales",
      city: "Paris",
      publisher: "Librairie Philosophique J. Vrin",
      year: "2019",
      visibleEvidence: {
        contributor: "Bonaventure",
        title: "Itinéraire de l'esprit jusqu'en Dieu",
        responsibilityStatement: "Introduction, notes et glossaire par Laure SOLIGNAC, traduction par André MÉNARD ofmcap",
        series: "Translatio Philosophies Médiévales",
        city: "Paris",
        publisher: "Librairie Philosophique J. Vrin",
        year: "2019",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Bonaventure. Itinéraire de l'esprit jusqu'en Dieu. Introduction, notes et glossaire par Laure Solignac, traduction par André Ménard. Translatio Philosophies Médiévales. Paris: Librairie Philosophique J. Vrin, 2019."
  );
});

test("credential initials are removed before author splitting", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Tim Arnold, Ph.D., Maya Rao, M.D.",
      title: "Credential Test",
      publisher: "Example Press",
      year: "2026",
      visibleEvidence: {
        contributor: "Tim Arnold, Ph.D., Maya Rao, M.D.",
        title: "Credential Test",
        publisher: "Example Press",
        year: "2026",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(result.heading, "Arnold, Tim, and Maya Rao. Credential Test. Example Press, 2026.");
  assert.doesNotMatch(result.heading, /Ph\.?D|M\.?D/i);
});

test("AI heading-only citation repairs malformed inverted initial author", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      heading: "Robinson, and Haddon W. Biblical Preaching: The Development and Delivery of Expository Messages. Fourth Edition. Bible Baptist Theological Seminary Press, 2025.",
      visibleEvidence: {
        heading: "Haddon W. Robinson Biblical Preaching The Development and Delivery of Expository Messages Fourth Edition Bible Baptist Theological Seminary Press 2025",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Robinson, Haddon W. Biblical Preaching: The Development and Delivery of Expository Messages. Fourth Edition. Bible Baptist Theological Seminary Press, 2025."
  );
  assert.doesNotMatch(result.heading, /Robinson,\s+and\s+Haddon/);
});

test("non-Latin contributors and titles keep visible order with bracketed English equivalents", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "해돈 W. 로빈슨 [Haddon W. Robinson]",
      title: "성경 강해설교 강해설교 전개와 전달 [Biblical Preaching The Development and Delivery of Expository Messages]",
      visibleEvidence: {
        contributor: "해돈 W. 로빈슨 Haddon W. Robinson",
        title: "성경 강해설교 강해설교 전개와 전달 Biblical Preaching The Development and Delivery of Expository Messages",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "해돈 W. 로빈슨 [Haddon W. Robinson]. 성경 강해설교 강해설교 전개와 전달 [Biblical Preaching The Development and Delivery of Expository Messages]."
  );
});

test("Worker forwards twelve rendered front-matter images to Gemini", async () => {
  const images = Array.from({ length: 12 }, (_, index) => ({
    pageNumber: index + 1,
    mimeType: "image/jpeg",
    data: "ZmFrZQ==",
  }));

  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images,
    parsedAiResponse: {
      heading: "",
      visibleEvidence: {},
    },
  });

  const parts = result.geminiRequestBody.contents[0].parts;
  assert.equal(parts.filter(part => part.inlineData).length, 12);
});
