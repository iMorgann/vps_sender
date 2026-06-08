"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { interpolate, toPlainText } = require("../lib/mime/builder");

test("interpolate: replaces template vars", () => {
  const result = interpolate("Hello {{name}}, email is {{email}}", { name: "Alice", email: "alice@example.com" });
  assert.equal(result, "Hello Alice, email is alice@example.com");
});

test("interpolate: leaves unknown vars empty", () => {
  const result = interpolate("Hello {{missing}}", {});
  assert.equal(result, "Hello ");
});

test("toPlainText: strips HTML tags", () => {
  const text = toPlainText("<p>Hello <b>World</b></p>");
  assert.ok(text.includes("Hello"));
  assert.ok(text.includes("World"));
  assert.ok(!text.includes("<"));
});

test("buildMime: produces a valid MIME buffer with Message-ID and List-Unsubscribe", async () => {
  const { buildMime } = require("../lib/mime/builder");
  const buf = await buildMime({
    to:        "test@example.com",
    fromEmail: "sender@domain.com",
    fromName:  "Test Sender",
    subject:   "Test subject",
    html:      "<p>Hello</p>",
    config:    { unsubscribeBaseUrl: "https://example.com/unsub" },
  });
  const raw = buf.toString("utf8");
  assert.ok(raw.includes("Message-ID:"), "should have Message-ID header");
  assert.ok(raw.includes("List-Unsubscribe:"), "should have List-Unsubscribe header");
  assert.ok(raw.includes("Precedence: bulk"), "should have Precedence header");
  assert.ok(raw.includes("Hello"), "should include body content");
});
