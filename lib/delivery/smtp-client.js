"use strict";

const tls    = require("tls");
const logger = require("../logger");
const { openRawSocket } = require("../net/proxy");

const SMTP_TIMEOUT = 20_000;

function writeLine(sock, line) {
  return new Promise((res, rej) =>
    sock.write(line + "\r\n", "utf8", e => e ? rej(e) : res())
  );
}

/**
 * Create a persistent buffered SMTP reader for a socket.
 * Shares one data listener and one buffer across all reads on the connection,
 * so data arriving between reads is never lost.
 */
function createSmtpReader(sock) {
  let buf      = "";
  let pending  = null; // { resolve, reject, timer }

  sock.on("data", chunk => {
    buf += chunk.toString();
    tryFlush();
  });

  sock.on("error", err => {
    if (pending) {
      clearTimeout(pending.timer);
      const { reject } = pending;
      pending = null;
      reject(err);
    }
  });

  function tryFlush() {
    if (!pending) return;
    const lines = buf.split("\n");
    // Scan all complete lines (all but the last which may be partial).
    // Walk forward finding the terminal line — a response is complete only when
    // a line matches "NNN " (space = final). Continuation lines use "NNN-".
    // We find the LAST terminal line in the buffer so that a multi-line response
    // is only resolved once all continuation lines have arrived.
    let termIdx = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i].trim())) termIdx = i;
    }
    if (termIdx === -1) return; // no complete response yet
    const termLine = lines[termIdx].trim();
    const message  = lines.slice(0, termIdx + 1).map(l => l.trim()).join("\n");
    buf = lines.slice(termIdx + 1).join("\n");
    clearTimeout(pending.timer);
    const { resolve } = pending;
    pending = null;
    resolve({ code: parseInt(termLine.slice(0, 3), 10), message });
  }

  function read() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        sock.destroy();
        reject(new Error("SMTP timeout"));
      }, SMTP_TIMEOUT);
      pending = { resolve, reject, timer };
      tryFlush(); // in case data already arrived
    });
  }

  return { read };
}

/**
 * Deliver a pre-built MIME buffer directly to an MX host on port 25.
 *
 * @param {string}  to           Recipient email
 * @param {string}  mxHost       Target MX server hostname
 * @param {Buffer}  mimeBuffer   Full MIME message (from buildMime)
 * @param {string}  fromEmail    Envelope FROM address
 * @param {string}  heloHost     Hostname to present in EHLO/HELO
 * @param {object}  opts         { proxy, tlsRejectUnauthorized }
 */
async function deliverEmail(to, mxHost, mimeBuffer, fromEmail, heloHost, opts = {}) {
  const {
    proxy                = null,
    tlsRejectUnauthorized = true,
    sendingIp            = null,
  } = opts;

  const localAddress = (sendingIp && sendingIp !== "auto") ? sendingIp : null;
  let sock = await openRawSocket(mxHost, 25, proxy, SMTP_TIMEOUT, localAddress);
  let usedTls = false;

  try {
    let reader = createSmtpReader(sock);

    let resp = await reader.read();
    if (resp.code !== 220) throw new Error(`Bad SMTP banner (${resp.code}): ${resp.message}`);

    await writeLine(sock, `EHLO ${heloHost}`);
    resp = await reader.read();

    if (resp.code !== 250) {
      // Fall back to HELO if EHLO rejected
      await writeLine(sock, `HELO ${heloHost}`);
      resp = await reader.read();
    }

    if (resp.message.includes("STARTTLS")) {
      await writeLine(sock, "STARTTLS");
      resp = await reader.read();
      if (resp.code === 220) {
        const plainSock = sock;
        const tlsSock = tls.connect({
          socket:             plainSock,
          servername:         mxHost,
          rejectUnauthorized: tlsRejectUnauthorized,
        });
        // Remove old listeners and attach new reader BEFORE secureConnect fires
        // so no data events are missed during the microtask gap after upgrade.
        plainSock.removeAllListeners("data");
        plainSock.removeAllListeners("error");
        sock   = tlsSock;
        reader = createSmtpReader(sock);
        await new Promise((res, rej) => {
          tlsSock.once("secureConnect", res);
          tlsSock.once("error", rej);
        });
        // Permanent handler ensures post-handshake TLS errors fast-fail the
        // pending read() rather than silently hanging for 20s (SMTP_TIMEOUT).
        tlsSock.on("error", () => { tlsSock.destroy(); });
        usedTls = true;

        await writeLine(sock, `EHLO ${heloHost}`);
        resp = await reader.read();
        if (resp.code !== 250) throw new Error(`EHLO rejected after TLS (${resp.code}): ${resp.message}`);
      }
    }

    await writeLine(sock, `MAIL FROM:<${fromEmail}>`);
    resp = await reader.read();
    if (resp.code !== 250) throw new Error(`MAIL FROM rejected (${resp.code}): ${resp.message}`);

    await writeLine(sock, `RCPT TO:<${to}>`);
    resp = await reader.read();
    if (resp.code !== 250 && resp.code !== 251) {
      throw new Error(`RCPT TO rejected (${resp.code}): ${resp.message}`);
    }

    await writeLine(sock, "DATA");
    resp = await reader.read();
    if (resp.code !== 354) throw new Error(`DATA rejected (${resp.code}): ${resp.message}`);

    // RFC-compliant dot-stuffing + CRLF
    const bodyStr = mimeBuffer.toString("utf8").replace(/\r?\n/g, "\r\n");
    const stuffed = bodyStr.split("\r\n")
      .map(line => line.startsWith(".") ? "." + line : line)
      .join("\r\n");

    await new Promise((res, rej) =>
      sock.write(stuffed + "\r\n.\r\n", "utf8", e => e ? rej(e) : res())
    );
    resp = await reader.read();
    if (resp.code !== 250) {
      throw new Error(`Message rejected (${resp.code}): ${resp.message}`);
    }

    await writeLine(sock, "QUIT");
    try { await reader.read(); } catch { /* ignore 221 or timeout on clean close */ }
    sock.destroy();

    logger.info("delivered", { to, from: fromEmail, mx: mxHost, tls: usedTls });
    return { tls: usedTls };
  } catch (e) {
    sock.destroy();
    logger.warn("delivery_failed", { to, from: fromEmail, mx: mxHost, error: e.message });
    throw e;
  }
}

module.exports = { deliverEmail };
