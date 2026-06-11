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

// Derive the organizational domain (last two labels) for DMARC inheritance lookups.
// e.g. send.example.com → example.com
function orgDomain(domain) {
  const parts = domain.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : domain;
}

async function checkSenderHealth(domain, sendingIp = null, dkimSelector = "mail") {
  const ip       = sendingIp || await detectSendingIp();
  const mailHost = `mail.${domain}`;
  const org      = orgDomain(domain);

  // Run all DNS lookups in parallel — including org-domain DMARC fallback
  const [mxRecs, spf, dmarc, dmarcOrg, dkim, ptr, aRoot, aMail] = await Promise.all([
    dns.resolveMx(domain).catch(() => []),
    checkSpf(domain),
    checkDmarc(domain),
    org !== domain ? checkDmarc(org) : Promise.resolve({ raw: null, policy: "none" }),
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

  // Use subdomain DMARC if present, otherwise fall back to org domain DMARC
  const effectiveDmarc = dmarc.raw ? dmarc : dmarcOrg;
  const dmarcSource    = dmarc.raw ? domain : (dmarcOrg.raw ? org : null);

  const warnings  = [];
  const advisories = []; // non-blocking issues
  const tips       = [];

  // ── Critical: SPF ──
  if (spf.strength === "none") {
    warnings.push(`No SPF record at ${domain}`);
    tips.push(`Add TXT at ${domain}: v=spf1 ip4:${ip} ~all`);
  } else if (spf.strength === "neutral") {
    warnings.push("SPF is neutral (?all) — not enforced by receiving servers.");
    tips.push("Change SPF ending to ~all (soft-fail) or -all (hard-fail).");
  }

  // ── Critical: DKIM ──
  if (!dkim.exists) {
    warnings.push(`No DKIM TXT record at ${dkimSelector}._domainkey.${domain}`);
    tips.push("Generate DKIM keys in the Sending Domains tab, then publish the TXT record.");
  }

  // ── Advisory: DMARC (also checks org domain for subdomains) ──
  if (!effectiveDmarc.raw) {
    advisories.push(`No DMARC record at _dmarc.${domain}${org !== domain ? ` or _dmarc.${org}` : ""}`);
    tips.push(`Add TXT at _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:dmarc@${org}`);
  }

  // ── Advisory: A records (existence only — IP matching not enforced) ──
  if (!aRoot.hasRecord) {
    advisories.push(`No A record for ${domain} — domain doesn't resolve to an IP`);
    tips.push(`Add A record: ${domain} → ${ip || "<your-server-ip>"}`);
  }
  if (!aMail.hasRecord) {
    advisories.push(`No A record for ${mailHost} — HELO/EHLO hostname won't resolve`);
    tips.push(`Add A record: ${mailHost} → ${ip || "<your-server-ip>"}`);
  }

  // ── Advisory: MX ──
  if (!mx.hasRecord) {
    advisories.push(`No MX record for ${domain} — bounces and replies can't be delivered`);
    tips.push(`Add MX record: ${domain} priority 10 → ${mailHost}`);
  }

  // ── Advisory: PTR / rDNS ──
  if (!ptr.ptr) {
    advisories.push(`No PTR/rDNS for IP ${ip}`);
    tips.push("Ask your VPS/hosting provider to set a PTR record for your sending IP.");
  } else if (!ptr.matches) {
    advisories.push(`PTR ${ptr.ptr} doesn't forward-confirm back to ${ip} (FCrDNS mismatch)`);
    tips.push(`Ensure ${ptr.ptr} has an A record pointing to ${ip}.`);
  }

  // Only SPF + DKIM are critical for "ready" — everything else is advisory
  const criticalMissing = spf.strength === "none" || !dkim.exists;
  const status = warnings.length === 0 ? "green"
    : criticalMissing                   ? "red"
    :                                     "yellow";

  return {
    domain, sendingIp: ip, spf, dkim,
    dmarc: effectiveDmarc, dmarcSource,
    ptr, mx, aRoot, aMail,
    status, warnings, advisories, tips,
  };
}

module.exports = { checkSenderHealth, detectSendingIp, checkSpf, checkDkim, checkDmarc, checkPtr, checkA };
