"use strict";

const nodemailer      = require("nodemailer");
const logger          = require("../logger");
const { openRawSocket } = require("../net/proxy");

/**
 * Deliver a mail options object directly to the recipient's MX server on port 25.
 * Uses nodemailer SMTP transport; proxy and source-IP binding go through getSocket.
 */
async function deliverEmail(to, mxHost, mailOptions, fromEmail, heloHost, opts = {}) {
  const {
    proxy                 = null,
    tlsRejectUnauthorized = true,
    sendingIp             = null,
  } = opts;

  const localAddress = (sendingIp && sendingIp !== "auto") ? sendingIp : null;

  const transportOpts = {
    host: mxHost,
    port: 25,
    secure: false,
    name:   heloHost,
    tls:    { rejectUnauthorized: tlsRejectUnauthorized },
    connectionTimeout: 20_000,
    socketTimeout:     20_000,
  };

  if (proxy || localAddress) {
    transportOpts.getSocket = (options, cb) => {
      openRawSocket(options.host, options.port, proxy, 20_000, localAddress)
        .then(sock => cb(null, sock))
        .catch(cb);
    };
  }

  const transporter = nodemailer.createTransport(transportOpts);

  try {
    await transporter.sendMail(mailOptions);
    // _smtp._secure is set true by nodemailer's SMTPConnection after STARTTLS upgrade
    const usedTls = !!(transporter._smtp && transporter._smtp._secure);
    logger.info("delivered", { to, from: fromEmail, mx: mxHost, tls: usedTls });
    return { tls: usedTls };
  } catch (e) {
    logger.warn("delivery_failed", { to, from: fromEmail, mx: mxHost, error: e.message });
    throw e;
  } finally {
    transporter.close();
  }
}

module.exports = { deliverEmail };
