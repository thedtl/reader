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

async function requestSuggestion({ parsedAiResponse, env = {}, lines = BIEREMA_LINES } = {}) {
  const originalFetch = globalThis.fetch;
  if (parsedAiResponse) {
    globalThis.fetch = async () => new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify(parsedAiResponse) }],
        },
      }],
    }), { status: 200 });
  }

  try {
    const request = new Request("https://example.test/suggest-heading", {
      method: "POST",
      body: JSON.stringify({ password: "test", lines }),
    });
    const response = await handleSuggestHeading(request, env, helpers);
    return response.json();
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
