"use strict";

const crypto       = require("crypto");
const MailComposer = require("nodemailer/lib/mail-composer/index.js");
const { getDkimOptions } = require("./dkim");

let htmlToText;
try { htmlToText = require("html-to-text").convert; } catch { htmlToText = null; }

/**
 * Template variable interpolation.
 * Replaces {{key}} with vars[key] (or empty string if missing).
 */
function interpolate(str, vars = {}) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

/**
 * Convert HTML to a clean plain-text alternative.
 * Uses html-to-text if available, otherwise strips tags.
 */
function toPlainText(html) {
  if (htmlToText) {
    return htmlToText(html, {
      wordwrap: 80,
      selectors: [
        { selector: "a",  options: { hideLinkHrefIfSameAsText: true } },
        { selector: "img", format: "skip" },
      ],
    });
  }
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Build a MIME message buffer ready for SMTP DATA.
 *
 * Options:
 *   to, fromEmail, fromName, subject, html, text (optional),
 *   attachments, config (full app config), templateVars
 *
 * Returns Buffer.
 */
function buildMime(opts) {
  const {
    to,
    fromEmail,
    fromName,
    subject,
    html:    rawHtml,
    text:    rawText,
    attachments = [],
    config  = {},
    templateVars = {},
  } = opts;

  // Template vars available in subject + body
  const vars = {
    email:   to,
    domain:  to.split("@")[1] || "",
    name:    fromName || "",
    ...templateVars,
  };
  if (config.unsubscribeBaseUrl) {
    vars.unsubscribe_url = `${config.unsubscribeBaseUrl}?email=${encodeURIComponent(to)}`;
  }

  const html = interpolate(rawHtml || "", vars);
  const text = rawText ? interpolate(rawText, vars) : toPlainText(html);
  const subj = interpolate(subject || "", vars);
  const safeName = fromName ? fromName.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : "";
  const from = safeName ? `"${safeName}" <${fromEmail}>` : fromEmail;

  const fromDomain = fromEmail.split("@")[1] || "localhost";
  const messageId  = `<${crypto.randomUUID()}@${fromDomain}>`;

  const headers = {
    "Message-ID":  messageId,
    "Precedence":  "bulk",
    "X-Mailer":    "VPS-Sender/2.0",
  };

  // List-Unsubscribe — required by Gmail + Yahoo bulk-sender policy
  if (vars.unsubscribe_url) {
    headers["List-Unsubscribe"]      = `<${vars.unsubscribe_url}>, <mailto:unsubscribe@${fromDomain}?subject=unsubscribe>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const dkimOptions = getDkimOptions(fromDomain, config);

  return new Promise((resolve, reject) => {
    const composer = new MailComposer({
      from,
      to,
      subject:     subj,
      html,
      text,
      attachments,
      headers,
      ...(dkimOptions ? { dkim: dkimOptions } : {}),
    });
    composer.compile().build((err, msg) => err ? reject(err) : resolve(msg));
  });
}

module.exports = { buildMime, interpolate, toPlainText };
