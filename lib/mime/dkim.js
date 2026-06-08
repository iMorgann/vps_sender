"use strict";

const fs   = require("fs");
const path = require("path");

/**
 * Load DKIM options for a domain from config.dkim map.
 * Returns nodemailer-compatible dkim options object, or null if not configured.
 *
 * config.dkim = {
 *   "example.com": {
 *     domainName: "example.com",
 *     keySelector: "mail",
 *     privateKeyPath: "./dkim/example.com/private.pem"
 *   }
 * }
 */
function getDkimOptions(fromDomain, config = {}) {
  const dkimMap = config.dkim || {};
  const entry   = dkimMap[fromDomain];
  if (!entry) return null;

  if (!entry.privateKeyPath || typeof entry.privateKeyPath !== "string") return null;
  const cwd     = path.resolve(process.cwd());
  const keyPath = path.resolve(cwd, entry.privateKeyPath);
  if (!keyPath.startsWith(cwd + path.sep)) return null; // block path traversal outside cwd
  if (!fs.existsSync(keyPath)) {
    return null; // key file missing — skip DKIM, don't crash
  }

  let privateKey;
  try {
    privateKey = fs.readFileSync(keyPath, "utf8");
  } catch {
    return null;
  }

  return {
    domainName:  entry.domainName || fromDomain,
    keySelector: entry.keySelector || "mail",
    privateKey,
  };
}

module.exports = { getDkimOptions };
