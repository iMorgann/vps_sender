"use strict";

const path   = require("path");
const logger = require("../logger");

let Database;
try { Database = require("better-sqlite3"); } catch { Database = null; }

const DB_PATH = path.join(process.cwd(), "campaign.db");

let _db = null;

function getDb() {
  if (_db) return _db;
  if (!Database) return null; // graceful degradation if better-sqlite3 not available

  try {
    // Open into a local variable — only assign _db after full successful init
    // so a failed pragma/exec doesn't leave a broken handle for future calls.
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_results (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT    NOT NULL DEFAULT 'default',
        email       TEXT    NOT NULL,
        from_email  TEXT,
        subject     TEXT,
        smtp_label  TEXT,
        status      TEXT    NOT NULL,
        error       TEXT,
        tls         INTEGER,
        created_at  TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        UNIQUE(campaign_id, email)
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_status ON campaign_results(campaign_id, status);
    `);
    _db = db;
    return _db;
  } catch (e) {
    logger.error("sqlite_init_failed", { error: e.message });
    return null;
  }
}

/**
 * Record a send result in SQLite (and optionally to CSV stream).
 */
function recordResult({ campaignId = "default", email, fromEmail, subject, smtpLabel, status, error = null, tls = null, csvStream = null }) {
  const db = getDb();
  if (db) {
    try {
      db.prepare(`
        INSERT OR REPLACE INTO campaign_results
          (campaign_id, email, from_email, subject, smtp_label, status, error, tls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(campaignId, email, fromEmail, subject, smtpLabel, status, error, tls != null ? (tls ? 1 : 0) : null);
    } catch (e) {
      logger.error("sqlite_write_failed", { error: e.message });
    }
  }

  // Dual-write to CSV for backward compatibility
  if (csvStream) {
    const safeSubject = (subject || "").replace(/"/g, "'");
    const safeError   = (error   || "").replace(/"/g, "'").replace(/\n.*/s, "").slice(0, 80);
    csvStream.write(`${email},${fromEmail},"${safeSubject}",${smtpLabel},${status},"${safeError}",${tls ? "true" : ""}\n`);
  }
}

/**
 * Load the set of already-sent emails for a campaign (for resume).
 * Falls back to parsing CSV if SQLite unavailable.
 */
function loadSentEmails(campaignId = "default", csvPath = null) {
  const sent = new Set();
  const db   = getDb();

  if (db) {
    try {
      const rows = db.prepare(
        "SELECT email FROM campaign_results WHERE campaign_id = ? AND status = 'sent'"
      ).all(campaignId);
      for (const row of rows) sent.add(row.email.toLowerCase().trim());
      return sent;
    } catch { /**/ }
  }

  // CSV fallback
  if (csvPath) {
    const fs = require("fs");
    if (fs.existsSync(csvPath)) {
      const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).slice(1);
      for (const l of lines) {
        // CSV format: email,from_email,"subject",smtp_label,status,...
        // Subject is quoted so may contain commas — parse it properly.
        // We only need email (col 0) and status (col 4).
        const emailEnd = l.indexOf(",");
        if (emailEnd < 0) continue;
        // Find status: skip from_email, skip quoted subject, skip smtp_label
        let pos = emailEnd + 1;
        // from_email (unquoted)
        const fromEnd = l.indexOf(",", pos);
        if (fromEnd < 0) continue;
        pos = fromEnd + 1;
        // subject (may be quoted)
        if (l[pos] === '"') {
          pos++; // skip opening quote
          while (pos < l.length) {
            if (l[pos] === '"' && l[pos + 1] === '"') { pos += 2; continue; } // RFC 4180 escaped quote
            if (l[pos] === '"') break; // closing quote
            pos++;
          }
          pos += 2; // skip closing quote + comma
        } else {
          const nextComma = l.indexOf(",", pos);
          if (nextComma < 0) continue;
          pos = nextComma + 1;
        }
        // smtp_label (unquoted)
        const smtpEnd = l.indexOf(",", pos);
        if (smtpEnd < 0) continue;
        pos = smtpEnd + 1;
        // status
        const statusEnd = l.indexOf(",", pos);
        const status = statusEnd < 0 ? l.slice(pos) : l.slice(pos, statusEnd);
        if (status.trim() === "sent") {
          sent.add(l.slice(0, emailEnd).toLowerCase().trim());
        }
      }
    }
  }

  return sent;
}

/** Export all results for a campaign as CSV string. */
function exportCsv(campaignId = "default") {
  const db = getDb();
  if (!db) return null;
  const rows = db.prepare(
    "SELECT * FROM campaign_results WHERE campaign_id = ? ORDER BY id"
  ).all(campaignId);

  function csvEscape(v) { const s = String(v == null ? "" : v).replace(/"/g, '""'); return `"${s}"`; }
  const header = "email,from_email,subject,smtp_label,status,error,tls,created_at\n";
  const body   = rows.map(r =>
    [r.email, r.from_email, r.subject, r.smtp_label, r.status, r.error, r.tls ? "true" : "", r.created_at]
      .map(csvEscape).join(",")
  ).join("\n");

  return header + body;
}

module.exports = { recordResult, loadSentEmails, exportCsv, getDb };
