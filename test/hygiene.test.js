"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { validateEmail, filterValid } = require("../lib/hygiene/validator");
const { deduplicate, cleanList }     = require("../lib/hygiene/deduplicator");

test("validateEmail: accepts valid addresses", () => {
  assert.deepEqual(validateEmail("user@example.com"), { valid: true });
  assert.deepEqual(validateEmail("a+b@sub.domain.io"), { valid: true });
  assert.deepEqual(validateEmail("USER@EXAMPLE.COM"), { valid: true });
});

test("validateEmail: rejects invalid addresses", () => {
  assert.equal(validateEmail("").valid, false);
  assert.equal(validateEmail("notanemail").valid, false);
  assert.equal(validateEmail("@nodomain.com").valid, false);
  assert.equal(validateEmail("user@").valid, false);
  assert.equal(validateEmail("user@domain..com").valid, false);
});

test("filterValid: splits valid and invalid", () => {
  const { valid, invalid } = filterValid(["good@example.com", "bad-email", "also@good.io"]);
  assert.deepEqual(valid,   ["good@example.com", "also@good.io"]);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].email, "bad-email");
});

test("deduplicate: removes case-insensitive duplicates", () => {
  const { unique, duplicateCount } = deduplicate(["a@b.com", "A@B.COM", "c@d.com", "a@b.com"]);
  assert.deepEqual(unique, ["a@b.com", "c@d.com"]);
  assert.equal(duplicateCount, 2);
});

test("cleanList: deduplicates and counts correctly", () => {
  const { emails, stats } = cleanList(["x@y.com", "x@y.com", "z@w.com"]);
  assert.equal(stats.duplicates, 1);
  assert.equal(emails.length, 2);
});
