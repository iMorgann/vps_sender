"use strict";

const dns  = require("dns").promises;
const http = require("http");
const https = require("https");

/**
 * Auto-detect the outbound public IP.
 * Falls back to SENDING_IP env var or "unknown".
 */
async function detectSendingIp() {
  if (process.env.SENDING_IP && process.env.SENDING_IP !== "auto") {
    return process.env.SENDING_IP;
  }
  return new Promise(resolve => {
    const req = https.get("https://api.ipify.org", { timeout: 5000 }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data.trim() || "unknown"));
    });
    req.on("error", () => {
      // fallback: try plain http
      const req2 = http.get("http://api4.ipify.org", { timeout: 5000 }, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => resolve(data.trim() || "unknown"));
      });
      req2.on("error", () => resolve("unknown"));
      req2.on("timeout", () => { req2.destroy(); resolve("unknown"); });
    });
    req.on("timeout", () => { req.destroy(); resolve("unknown"); });
  });
}

/**
 * Check PTR / rDNS for an IP address.
 * Returns { ptr, matches } where matches = PTR hostname resolves back to same IP.
 */
async function checkPtr(ip) {
  if (!ip || ip === "unknown") return { ptr: null, matches: false };
  try {
    const hostnames = await dns.reverse(ip);
    const ptr = hostnames[0] || null;
    if (!ptr) return { ptr: null, matches: false };
    // Forward-confirm the PTR
    const forward = await dns.resolve4(ptr).catch(() => []);
    return { ptr, matches: forward.includes(ip) };
  } catch {
    return { ptr: null, matches: false };
  }
}

/**
 * Check SPF record for a domain.
 * Returns { raw, strength } — strength: "hard" | "soft" | "neutral" | "none"
 */
async function checkSpf(domain) {
  const txts = await dns.resolveTxt(domain).catch(() => []);
  let raw = null;
  for (const chunks of txts) {
    const line = chunks.join("");
    if (line.toLowerCase().startsWith("v=spf1")) { raw = line; break; }
  }
  if (!raw) return { raw: null, strength: "none" };
  const strength = raw.includes("-all") ? "hard"
    : raw.includes("~all") ? "soft"
    : "neutral";
  return { raw, strength };
}

/**
 * Check DMARC policy for a domain.
 * Returns { raw, policy } — policy: "none" | "quarantine" | "reject"
 */
async function checkDmarc(domain) {
  const txts = await dns.resolveTxt(`_dmarc.${domain}`).catch(() => []);
  let raw = null;
  for (const chunks of txts) {
    const line = chunks.join("");
    if (line.toLowerCase().startsWith("v=dmarc1")) { raw = line; break; }
  }
  if (!raw) return { raw: null, policy: "none" };
  const policy = (raw.match(/\bp=(\w+)/i)?.[1] || "none").toLowerCase();
  return { raw, policy };
}

/**
 * Check DKIM public key record for a domain + selector.
 * Returns { exists, selector }
 */
async function checkDkim(domain, selector = "mail") {
  const host = `${selector}._domainkey.${domain}`;
  try {
    const txts = await dns.resolveTxt(host);
    const found = txts.some(chunks => chunks.join("").includes("v=DKIM1"));
    return { exists: found, selector };
  } catch {
    return { exists: false, selector };
  }
}

/**
 * Full sender health check.
 *
 * Returns {
 *   domain, sendingIp,
 *   spf:   { raw, strength },
 *   dkim:  { exists, selector },
 *   dmarc: { raw, policy },
 *   ptr:   { ptr, matches },
 *   mx:    { host, records },
 *   status: "green" | "yellow" | "red",
 *   warnings: string[],
 *   tips: string[]
 * }
 */
/**
 * Check A records for a hostname.
 * Returns { addrs, hasRecord }
 */
async function checkA(hostname) {
  try {
    const addrs = await dns.resolve4(hostname);
    return { addrs, hasRecord: addrs.length > 0 };
  } catch {
    return { addrs: [], hasRecord: false };
  }
}

async function checkSenderHealth(domain, sendingIp = null, dkimSelector = "mail") {
  const ip = sendingIp || await detectSendingIp();
  const mailHost = `mail.${domain}`;

  const [mxRecs, spf, dmarc, dkim, ptr, aRoot, aMail] = await Promise.all([
    dns.resolveMx(domain).catch(() => []),
    checkSpf(domain),
    checkDmarc(domain),
    checkDkim(domain, dkimSelector),
    checkPtr(ip),
    checkA(domain),
    checkA(mailHost),
  ]);

  mxRecs.sort((a, b) => a.priority - b.priority);
  const mx = {
    host:      mxRecs[0]?.exchange || null,
    records:   mxRecs,
    hasRecord: mxRecs.length > 0,
  };

  const warnings = [];
  const tips     = [];

  if (!aRoot.hasRecord) {
    warnings.push(`No A record for ${domain} — the domain does not resolve to any IP.`);
    tips.push(`Add A record: ${domain} → ${ip}`);
  } else if (ip && ip !== "unknown" && !aRoot.addrs.includes(ip)) {
    warnings.push(`A record for ${domain} points to ${aRoot.addrs[0]} but sending IP is ${ip}.`);
    tips.push(`Update A record: ${domain} → ${ip}`);
  }

  if (!aMail.hasRecord) {
    warnings.push(`No A record for ${mailHost} — HELO/EHLO hostname will not resolve.`);
    tips.push(`Add A record: ${mailHost} → ${ip}`);
  } else if (ip && ip !== "unknown" && !aMail.addrs.includes(ip)) {
    warnings.push(`A record for ${mailHost} points to ${aMail.addrs[0]} but sending IP is ${ip}.`);
    tips.push(`Update A record: ${mailHost} → ${ip}`);
  }

  if (!mx.hasRecord) {
    warnings.push(`No MX record for ${domain} — bounces and replies cannot be delivered.`);
    tips.push(`Add MX record: ${domain} → 10 ${mailHost}`);
  }

  if (spf.strength === "none") {
    warnings.push("No SPF record — receiving servers cannot verify your sending IP.");
    tips.push(`Add TXT record at ${domain}: v=spf1 ip4:${ip} ~all`);
  } else if (spf.strength === "neutral") {
    warnings.push("SPF is neutral (?all) — not enforced.");
    tips.push("Change SPF to ~all (soft-fail) or -all (hard-fail).");
  }

  if (!dkim.exists) {
    warnings.push(`No DKIM public key found at ${dkimSelector}._domainkey.${domain}`);
    tips.push("Generate DKIM keys in the Sending Domains tab, then publish the DNS TXT record.");
  }

  if (dmarc.policy === "none") {
    warnings.push("No DMARC record — no protection against spoofing.");
    tips.push(`Add TXT record at _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:dmarc@${domain}`);
  }

  if (!ptr.ptr) {
    warnings.push(`No PTR / rDNS for IP ${ip} — some servers may reject or score down.`);
    tips.push("Contact your hosting provider to set a PTR record for your IP.");
  } else if (!ptr.matches) {
    warnings.push(`PTR record ${ptr.ptr} does not resolve back to ${ip} (FCrDNS mismatch).`);
    tips.push("Ensure your PTR hostname A record points back to your IP.");
  }

  const criticalMissing = spf.strength === "none" || !dkim.exists || dmarc.policy === "none";
  const status = warnings.length === 0 ? "green"
    : criticalMissing                   ? "yellow"
    :                                     "yellow";

  return { domain, sendingIp: ip, spf, dkim, dmarc, ptr, mx, aRoot, aMail, status, warnings, tips };
}

module.exports = { checkSenderHealth, detectSendingIp, checkSpf, checkDkim, checkDmarc, checkPtr, checkA };
