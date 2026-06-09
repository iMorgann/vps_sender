"use strict";

const crypto = require("crypto");
const { getDkimOptions } = require("./dkim");

const MAILER_CLIENTS = [
  (v) => `Microsoft Outlook ${v.maj}.0.${v.build}`,
  (v) => `Apple Mail ${v.maj}.${v.min}`,
  (v) => `Thunderbird ${v.maj}.${v.min}.${v.patch}`,
  (v) => `Lotus Notes ${v.maj}.${v.min}`,
  (v) => `Mutt/${v.maj}.${v.min}.${v.patch}i`,
  (v) => `YahooMailWebService/${v.build}`,
  (v) => `MailMate ${v.maj}.${v.min}`,
  (v) => `Evolution ${v.maj}.${v.min}.${v.patch}`,
  (v) => `The Bat! ${v.maj}.${v.min}.${v.patch}`,
  (v) => `eM Client ${v.maj}.${v.min}.${v.build}`,
];

function randomMailer() {
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const v = { maj: rnd(10, 18), min: rnd(0, 9), patch: rnd(0, 9), build: rnd(1000, 9999) };
  const client = MAILER_CLIENTS[Math.floor(Math.random() * MAILER_CLIENTS.length)];
  return client(v);
}

let htmlToText;
try { htmlToText = require("html-to-text").convert; } catch { htmlToText = null; }

/**
 * Template variable interpolation — replaces {{key}} with vars[key].
 */
function interpolate(str, vars = {}) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function toPlainText(html) {
  if (htmlToText) {
    return htmlToText(html, {
      wordwrap: 80,
      selectors: [
        { selector: "a",   options: { hideLinkHrefIfSameAsText: true } },
        { selector: "img", format: "skip" },
      ],
    });
  }
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Build a nodemailer mail options object ready for transporter.sendMail().
 *
 * When config.envelopeDomain is set the envelope FROM uses that domain
 * (SPF+DKIM alignment) while the header From: keeps the visible sender address
 * — this is the split-header signing technique for "any visible FROM" support.
 *
 * Returns a plain object (synchronous).
 */
function buildMailOptions(opts) {
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

  const vars = {
    email:  to,
    domain: to.split("@")[1] || "",
    name:   fromName || "",
    ...templateVars,
  };
  if (config.unsubscribeBaseUrl) {
    vars.unsubscribe_url = `${config.unsubscribeBaseUrl}?email=${encodeURIComponent(to)}`;
  }

  const html = interpolate(rawHtml || "", vars);
  const text = rawText ? interpolate(rawText, vars) : toPlainText(html);
  const subj = interpolate(subject || "", vars);
  const safeName   = fromName ? fromName.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : "";
  const displayFrom = safeName ? `"${safeName}" <${fromEmail}>` : fromEmail;

  const fromDomain    = fromEmail.split("@")[1] || "localhost";
  const messageId     = `<${crypto.randomUUID()}@${fromDomain}>`;

  // Split-header: envelope uses envelopeDomain for SPF/DKIM alignment;
  // header From: stays as the visible address.
  const envelopeDomain = config.envelopeDomain || "";
  const envelopeFrom   = envelopeDomain ? `bounce@${envelopeDomain}` : fromEmail;
  const dkimDomain     = envelopeDomain || fromDomain;
  const dkimOptions    = getDkimOptions(dkimDomain, config);

  const headers = {
    "Message-ID": messageId,
    "Precedence": "bulk",
    "X-Mailer":   randomMailer(),
  };
  if (vars.unsubscribe_url) {
    headers["List-Unsubscribe"]      = `<${vars.unsubscribe_url}>, <mailto:unsubscribe@${fromDomain}?subject=unsubscribe>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  return {
    envelope: { from: envelopeFrom, to },
    from:     displayFrom,
    to,
    subject:  subj,
    html,
    text,
    attachments,
    headers,
    ...(dkimOptions ? { dkim: dkimOptions } : {}),
  };
}

module.exports = { buildMailOptions, interpolate, toPlainText };
