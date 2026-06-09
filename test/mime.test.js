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

test("buildMailOptions: returns object with Message-ID, List-Unsubscribe, and body content", () => {
  const { buildMailOptions } = require("../lib/mime/builder");
  const opts = buildMailOptions({
    to:        "test@example.com",
    fromEmail: "sender@domain.com",
    fromName:  "Test Sender",
    subject:   "Test subject",
    html:      "<p>Hello</p>",
    config:    { unsubscribeBaseUrl: "https://example.com/unsub" },
  });
  assert.ok(opts.headers["Message-ID"],         "should have Message-ID header");
  assert.ok(opts.headers["List-Unsubscribe"],   "should have List-Unsubscribe header");
  assert.equal(opts.headers["Precedence"], "bulk", "should have Precedence: bulk");
  assert.ok(opts.html.includes("Hello"),        "should include body content");
  assert.equal(opts.to,   "test@example.com");
  assert.ok(opts.from.includes("sender@domain.com"));
});
