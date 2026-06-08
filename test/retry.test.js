"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { withRetry, classifySmtpError } = require("../lib/delivery/retry");

test("classifySmtpError: identifies transient 4xx", () => {
  assert.equal(classifySmtpError(new Error("450 try again")), "transient");
  assert.equal(classifySmtpError(new Error("421 service unavailable")), "transient");
});

test("classifySmtpError: identifies permanent 5xx", () => {
  assert.equal(classifySmtpError(new Error("550 user unknown")), "permanent");
  assert.equal(classifySmtpError(new Error("521 rejected")), "permanent");
});

test("classifySmtpError: unknown for no code", () => {
  assert.equal(classifySmtpError(new Error("Connection refused")), "unknown");
});

test("withRetry: succeeds on first attempt", async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return "ok"; }, { maxRetries: 3, baseDelay: 10 });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry: throws immediately on permanent 5xx", async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error("550 permanent"); }, { maxRetries: 3, baseDelay: 10 }),
    /550/
  );
  assert.equal(calls, 1, "should not retry on 5xx");
});

test("withRetry: cancels when token is set", async () => {
  const cancelToken = { cancelled: false };
  let calls = 0;
  const p = withRetry(async () => { calls++; throw new Error("connection refused"); }, { maxRetries: 5, baseDelay: 50, cancelToken });
  cancelToken.cancelled = true;
  await assert.rejects(() => p);
});
