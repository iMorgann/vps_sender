"use strict";
const dns = require("dns").promises;

const DNSBL_PROVIDERS = [
  { name: "Spamhaus ZEN",  host: "zen.spamhaus.org",        delist: "https://www.spamhaus.org/lookup/" },
  { name: "Mailspike",     host: "bl.mailspike.net",        delist: "https://www.mailspike.net/lookup.html" },
  { name: "Barracuda",     host: "b.barracudacentral.org",  delist: "https://www.barracudacentral.org/rbl/removal-request" },
  { name: "SORBS",         host: "dnsbl.sorbs.net",         delist: "http://www.sorbs.net/lookup.shtml" },
  { name: "PSBL",          host: "psbl.surriel.com",        delist: "https://psbl.org/remove" },
  { name: "CBL / Abuseat", host: "cbl.abuseat.org",         delist: "https://www.abuseat.org/lookup.cgi" },
  { name: "UCEProtect L1", host: "dnsbl-1.uceprotect.net", delist: "http://www.uceprotect.net/en/rblcheck.php" },
  { name: "SpamCop",       host: "bl.spamcop.net",          delist: "https://www.spamcop.net/bl.shtml" },
];

function reverseIp(ip) {
  return ip.split(".").reverse().join(".");
}

async function checkOne(ip, provider) {
  try {
    const addrs = await dns.resolve4(`${reverseIp(ip)}.${provider.host}`);
    return { ...provider, listed: true, returnCode: addrs[0] || "" };
  } catch (err) {
    if (err.code === "ENOTFOUND" || err.code === "ENODATA") {
      return { ...provider, listed: false };
    }
    return { ...provider, listed: false, error: err.code };
  }
}

async function checkAllBlacklists(ip) {
  const results = await Promise.all(DNSBL_PROVIDERS.map(p => checkOne(ip, p)));
  return {
    ip,
    listed:    results.filter(r => r.listed),
    clean:     results.filter(r => !r.listed && !r.error),
    errors:    results.filter(r => r.error),
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { checkAllBlacklists, DNSBL_PROVIDERS };
