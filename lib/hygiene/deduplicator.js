"use strict";

const fs   = require("fs");
const path = require("path");

const SUPPRESSION_FILE = path.join(process.cwd(), "suppression.txt");

/**
 * Deduplicate a list of emails (case-insensitive).
 * Returns { unique: string[], duplicateCount: number }
 */
function deduplicate(emails) {
  const seen = new Set();
  const unique = [];
  for (const e of emails) {
    const key = (e || "").trim().toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); unique.push(key); }
  }
  return { unique, duplicateCount: emails.length - unique.length };
}

/**
 * Load the suppression list from suppression.txt (one email per line).
 * Returns a Set of lowercased emails.
 */
function loadSuppressionList(filePath = SUPPRESSION_FILE) {
  const list = new Set();
  if (!fs.existsSync(filePath)) return list;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const l of lines) {
    const e = l.trim().toLowerCase();
    if (e && !e.startsWith("#")) list.add(e);
  }
  return list;
}

/**
 * Add an email to the suppression list file.
 */
function addToSuppressionList(email, filePath = SUPPRESSION_FILE) {
  const e = (email || "").trim().toLowerCase();
  if (!e) return;
  fs.appendFileSync(filePath, e + "\n", "utf8");
}

/**
 * Apply deduplication + suppression list filtering.
 *
 * Returns { emails: string[], stats: { original, duplicates, suppressed, final } }
 */
function cleanList(rawEmails, suppressionFilePath = SUPPRESSION_FILE) {
  const original = rawEmails.length;

  const { unique, duplicateCount } = deduplicate(rawEmails);
  const suppressed = loadSuppressionList(suppressionFilePath);

  const emails    = unique.filter(e => !suppressed.has(e));
  const suppressedCount = unique.length - emails.length;

  return {
    emails,
    stats: {
      original,
      duplicates:  duplicateCount,
      suppressed:  suppressedCount,
      final:       emails.length,
    },
  };
}

module.exports = { deduplicate, loadSuppressionList, addToSuppressionList, cleanList };
