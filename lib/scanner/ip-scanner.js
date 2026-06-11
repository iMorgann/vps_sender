"use strict";

const dns = require("dns");
const net = require("net");
const { checkSpf, checkDmarc } = require("./sender-health");

async function probePort25OnIp(ip, timeout = 8000) {
  return new Promise(resolve => {
    const sock   = net.createConnection({ host: ip, port: 25 });
    let   banner = "";
    const timer  = setTimeout(() => { sock.destroy(); resolve({ open: false, banner: "" }); }, timeout);
    sock.once("data", d => {
      banner = d.toString("utf8").split("\n")[0].trim();
      clearTimeout(timer);
      sock.destroy();
      resolve({ open: true, banner });
    });
    sock.once("error", () => { clearTimeout(timer); resolve({ open: false, banner: "" }); });
  });
}

async function scanIp(ip) {
  let ptrHost = null;
  try {
    const ptrs = await dns.promises.reverse(ip);
    if (ptrs && ptrs.length) ptrHost = ptrs[0];
  } catch { /* no PTR record */ }

  const domain = ptrHost ? ptrHost.split(".").slice(-2).join(".") : null;

  const [spf, dmarc, port25] = await Promise.all([
    domain ? checkSpf(domain)   : Promise.resolve({ strength: "none", raw: null }),
    domain ? checkDmarc(domain) : Promise.resolve({ policy: "none",   raw: null }),
    probePort25OnIp(ip),
  ]);

  let score = 0;
  if (port25.open)              score += 2;
  if (ptrHost)                  score += 1;
  if (spf.strength !== "none")  score += 1;
  if (dmarc.policy !== "none")  score += 1;

  return {
    ip,
    ptrHost,
    domain,
    port25Open:   port25.open,
    port25Banner: port25.banner,
    spfStrength:  spf.strength,
    spfRaw:       spf.raw,
    dmarcPolicy:  dmarc.policy,
    dmarcRaw:     dmarc.raw,
    score,
    usable: port25.open && !!ptrHost,
  };
}

async function scanIps(ips, concurrency, onProgress, cancelToken) {
  const results = [];
  const queue   = [...ips];
  let   done    = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      if (cancelToken && cancelToken.cancelled) break;
      const ip = queue.shift();
      if (!ip) break;
      const r = await scanIp(ip);
      results.push(r);
      onProgress && onProgress(++done, ips.length, r);
    }
  });

  await Promise.all(workers);
  return results;
}

module.exports = { scanIp, scanIps };
