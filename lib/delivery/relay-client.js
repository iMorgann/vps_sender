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
  } = opts;

  const transporter = nodemailer.createTransport({
    host: relayHost,
    port: relayPort,
    secure: false,
    auth: relayUser ? { user: relayUser, pass: relayPass } : undefined,
    connectionTimeout: 15_000,
    socketTimeout:     15_000,
  });

  try {
    await transporter.sendMail(mailOptions);
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
