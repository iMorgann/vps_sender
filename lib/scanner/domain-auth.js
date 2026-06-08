"use strict";

const dns    = require("dns").promises;
const { openRawSocket } = require("../net/proxy");

/**
 * Full port-25 probe: DNS MX → TCP → read 220 banner → QUIT.
 * Returns { mx, banner, open }
 */
async function probePort25(domain, proxy = null, timeout = 8000) {
  // MX lookup
  let mx = null;
  try {
    const recs = await dns.resolveMx(domain);
    if (recs && recs.length) {
      recs.sort((a, b) => a.priority - b.priority);
      mx = recs[0].exchange;
    }
  } catch { /**/ }

  if (!mx) {
    // Fallback: try domain itself as A record
    try { const a = await dns.resolve4(domain); if (a && a.length) mx = domain; } catch { /**/ }
  }
  if (!mx) return { mx: null, banner: null, open: false };

  try {
    const sock = await openRawSocket(mx, 25, proxy, timeout);
    return await new Promise(resolve => {
      let buf = "";
      const timer = setTimeout(() => {
        sock.destroy();
        resolve({ mx, banner: null, open: false });
      }, timeout);

      sock.once("error", () => { clearTimeout(timer); resolve({ mx, banner: null, open: false }); });
      sock.on("data", chunk => {
        buf += chunk.toString();
        if (/^\d{3}[ -]/m.test(buf)) {
          clearTimeout(timer);
          try { sock.write("QUIT\r\n"); } catch { /**/ }
          sock.destroy();
          const firstLine = buf.split(/\r?\n/)[0].trim();
          const code = parseInt(firstLine.slice(0, 3), 10);
          resolve({ mx, banner: firstLine, open: code === 220 });
        }
      });
    });
  } catch {
    return { mx, banner: null, open: false };
  }
}

/**
 * Check a domain's MX, SPF, DMARC, and port 25.
 * Returns full domain auth object used by the scanner UI.
 */
async function checkDomainAuth(domain, proxy = null) {
  const [mxRecs, spfTxts, dmarcTxts] = await Promise.all([
    dns.resolveMx(domain).catch(() => []),
    dns.resolveTxt(domain).catch(() => []),
    dns.resolveTxt(`_dmarc.${domain}`).catch(() => []),
  ]);

  let mx = null;
  if (mxRecs.length) { mxRecs.sort((a, b) => a.priority - b.priority); mx = mxRecs[0].exchange; }

  let spfRaw = null;
  for (const chunks of spfTxts) {
    const line = chunks.join("");
    if (line.toLowerCase().startsWith("v=spf1")) { spfRaw = line; break; }
  }

  let dmarcRaw = null;
  for (const chunks of dmarcTxts) {
    const line = chunks.join("");
    if (line.toLowerCase().startsWith("v=dmarc1")) { dmarcRaw = line; break; }
  }

  const spfStrength = !spfRaw ? "none"
    : spfRaw.includes("-all") ? "hard"
    : spfRaw.includes("~all") ? "soft"
    : "neutral";

  const dmarcPolicy = !dmarcRaw ? "none"
    : (dmarcRaw.match(/\bp=(\w+)/i)?.[1] || "none").toLowerCase();

  // Port 25 probe
  const probe = mx ? await probePort25(domain, proxy) : { mx: null, banner: null, open: false };

  return {
    domain,
    hasMx:        !!mx,
    mx:           probe.mx || mx,
    open:         probe.open,   // consistent with probePort25 return shape
    port25Open:   probe.open,   // alias kept for scanner UI
    port25Banner: probe.banner,
    spfRaw,
    spfStrength,
    dmarcRaw,
    dmarcPolicy,
  };
}

/**
 * Run domain auth checks across multiple domains in parallel.
 * Returns array of checkDomainAuth results.
 */
async function scanDomains(domains, proxy = null, concurrency = 8, onProgress = null, cancelToken = null) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (true) {
      if (cancelToken && cancelToken.cancelled) break;
      const myIdx = idx++;
      if (myIdx >= domains.length) break;
      const domain = domains[myIdx];
      const info   = await checkDomainAuth(domain, proxy);
      results.push(info);
      if (onProgress) onProgress(results.length, domains.length, info);
    }
  }

  const workers = Math.min(concurrency, domains.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

module.exports = { probePort25, checkDomainAuth, scanDomains };
