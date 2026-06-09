"use strict";

const nodemailer = require("nodemailer");
const logger     = require("../logger");

/**
 * Submit mail via a local MTA relay (hMailServer / Postfix on localhost:587).
 * The mxHost parameter is unused — relay decides the outbound route.
 */
async function deliverViaRelay(to, _mxHost, mailOptions, fromEmail, _heloHost, opts = {}) {
  const {
    relayHost = "127.0.0.1",
    relayPort = 587,
    relayUser,
    relayPass,
    relayTlsRejectUnauthorized = false,
    relayFromEmail = "",  // envelope MAIL FROM override (e.g. Mailcow authenticated user)
  } = opts;

  const transporter = nodemailer.createTransport({
    host:   relayHost,
    port:   relayPort,
    secure: false,
    auth:   relayUser ? { user: relayUser, pass: relayPass } : undefined,
    tls:    { rejectUnauthorized: relayTlsRejectUnauthorized },
    connectionTimeout: 15_000,
    socketTimeout:     15_000,
  });

  // When relayFromEmail is set, override the SMTP envelope MAIL FROM while keeping
  // the display From: header unchanged. This is required for relays (e.g. Mailcow)
  // that enforce the envelope sender must match the authenticated account.
  const sendOpts = relayFromEmail
    ? { ...mailOptions, envelope: { from: relayFromEmail, to } }
    : mailOptions;

  try {
    await transporter.sendMail(sendOpts);
    const usedTls = !!(transporter._smtp && transporter._smtp._secure);
    logger.info("relayed", { to, from: fromEmail, relay: `${relayHost}:${relayPort}`, tls: usedTls });
    return { tls: usedTls };
  } catch (e) {
    logger.warn("relay_failed", { to, from: fromEmail, relay: `${relayHost}:${relayPort}`, error: e.message });
    throw e;
  } finally {
    transporter.close();
  }
}

module.exports = { deliverViaRelay };
