"use strict";

const logger = require("../logger");

/**
 * Classify an SMTP error by its numeric code.
 * Returns "transient" (4xx — retry), "permanent" (5xx — skip), or "unknown".
 */
function classifySmtpError(err) {
  const match = err.message.match(/\b([45]\d\d)\b/);
  if (!match) return "unknown";
  const code = parseInt(match[1], 10);
  if (code >= 400 && code < 500) return "transient";
  if (code >= 500 && code < 600) return "permanent";
  return "unknown";
}

/**
 * Attempt delivery with smart backoff retries.
 *
 * - 5xx → permanent failure, no retry
 * - 4xx (greylist) → wait greylistWait ms, retry up to maxRetries times
 * - Network error → wait baseDelay ms, retry
 *
 * @param {Function} deliverFn    async () => result  (throws on failure)
 * @param {object}   opts
 *   maxRetries      {number}  max greylist / transient retries (default 3)
 *   greylistWait    {number}  ms to wait on 4xx (default 60000)
 *   baseDelay       {number}  ms to wait on network error (default 5000)
 *   onRetry         {Function} (attempt, reason, waitMs) => void  — progress callback
 *   cancelToken     {object}  { cancelled }
 */
async function withRetry(deliverFn, opts = {}) {
  const {
    maxRetries   = 3,
    greylistWait = 60_000,
    baseDelay    = 5_000,
    onRetry      = () => {},
    cancelToken  = { cancelled: false },
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (cancelToken.cancelled) throw new Error("Cancelled");

    try {
      return await deliverFn();
    } catch (err) {
      if (cancelToken.cancelled) throw new Error("Cancelled"); // propagate cancel cleanly, not the SMTP error
      lastErr = err;
      const kind = classifySmtpError(err);

      if (kind === "permanent") {
        logger.warn("permanent_failure", { error: err.message });
        throw err; // no point retrying
      }

      if (attempt >= maxRetries) break;

      const waitMs = kind === "transient" ? greylistWait : baseDelay * Math.pow(2, attempt);
      onRetry(attempt + 1, kind === "transient" ? "greylisted" : "network_error", waitMs);
      logger.info("retry_scheduled", { attempt: attempt + 1, waitMs, error: err.message });

      await sleep(waitMs, cancelToken);
    }
  }

  throw lastErr;
}

function sleep(ms, cancelToken = { cancelled: false }) {
  return new Promise((res, rej) => {
    const end = Date.now() + ms;
    const tick = setInterval(() => {
      if (cancelToken.cancelled) { clearInterval(tick); rej(new Error("Cancelled")); return; }
      if (Date.now() >= end)     { clearInterval(tick); res(); }
    }, 500);
  });
}

module.exports = { withRetry, classifySmtpError };
