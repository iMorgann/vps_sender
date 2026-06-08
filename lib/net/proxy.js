"use strict";

const net = require("net");

/**
 * Parse a socks4/socks5 URL into a proxy config object.
 * Returns null for empty/invalid input.
 */
function parseProxyUrl(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const u    = new URL(raw.trim());
    const type = u.protocol === "socks4:" ? 4 : 5;
    return {
      type,
      host:     u.hostname,
      port:     parseInt(u.port, 10) || 1080,
      userId:   u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch { return null; }
}

/**
 * Open a raw TCP socket to host:port.
 * Routes through SOCKS5/4 when proxy is provided.
 */
async function openRawSocket(host, port, proxy = null, timeoutMs = 15000) {
  if (!proxy) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port });
      s.setNoDelay(true);
      s.setTimeout(timeoutMs);
      s.once("connect", () => { s.setTimeout(0); resolve(s); });
      s.once("timeout", () => { s.destroy(); reject(new Error("Connect timeout")); });
      s.once("error", reject);
    });
  }

  const { SocksClient } = require("socks");
  const info = await SocksClient.createConnection({
    proxy: {
      host:     proxy.host,
      port:     proxy.port,
      type:     proxy.type,
      userId:   proxy.userId,
      password: proxy.password,
    },
    command:     "connect",
    destination: { host, port },
    timeout:     timeoutMs,
  });
  return info.socket;
}

module.exports = { parseProxyUrl, openRawSocket };
