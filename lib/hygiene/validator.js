"use strict";

// RFC 5322 simplified — catches obvious invalids without over-rejecting
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

/**
 * Validate a single email address.
 * Returns { valid: bool, reason?: string }
 */
function validateEmail(email) {
  if (!email || typeof email !== "string") return { valid: false, reason: "empty" };
  const e = email.trim();
  if (e.length > 254)           return { valid: false, reason: "too_long" };
  if (!EMAIL_RE.test(e))        return { valid: false, reason: "format" };
  const [local, domain] = e.split("@");
  if (local.length > 64)        return { valid: false, reason: "local_too_long" };
  if (domain.includes(".."))    return { valid: false, reason: "consecutive_dots" };
  if (domain.startsWith(".") || domain.endsWith(".")) return { valid: false, reason: "dot_at_boundary" };
  return { valid: true };
}

/**
 * Filter a list of raw email strings, returning only valid ones.
 * Logs a summary of how many were rejected and why.
 */
function filterValid(emails) {
  const valid   = [];
  const invalid = [];

  for (const raw of emails) {
    const e   = (raw || "").trim().toLowerCase();
    const res = validateEmail(e);
    if (res.valid) valid.push(e);
    else           invalid.push({ email: e, reason: res.reason });
  }

  return { valid, invalid };
}

module.exports = { validateEmail, filterValid };
