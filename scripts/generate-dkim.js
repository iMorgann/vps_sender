#!/usr/bin/env node
"use strict";

/**
 * DKIM key generation script.
 * Usage: node scripts/generate-dkim.js [domain] [selector]
 *
 * Outputs:
 *   dkim/<domain>/private.pem  — private key (keep secret)
 *   dkim/<domain>/public.pem   — public key (for DNS TXT record)
 *   dkim/<domain>/dns.txt      — ready-to-paste DNS TXT record
 */

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");
const rl     = require("readline").createInterface({ input: process.stdin, output: process.stdout });

function ask(q, def) {
  return new Promise(res => rl.question(`${q} [${def}]: `, a => res(a.trim() || def)));
}

(async () => {
  const domain   = process.argv[2] || await ask("Domain", "example.com");
  const selector = process.argv[3] || await ask("Selector", "mail");
  rl.close();

  const dir = path.join(process.cwd(), "dkim", domain);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\nGenerating 2048-bit RSA key pair for ${domain}…`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength:    2048,
    publicKeyEncoding:  { type: "spki",  format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  fs.writeFileSync(path.join(dir, "private.pem"), privateKey, "utf8");
  fs.writeFileSync(path.join(dir, "public.pem"),  publicKey,  "utf8");

  // Extract raw base64 from PEM (strip header/footer + newlines)
  const pubRaw = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");

  const dnsRecord = `v=DKIM1; k=rsa; p=${pubRaw}`;
  const dnsName   = `${selector}._domainkey.${domain}`;

  fs.writeFileSync(path.join(dir, "dns.txt"), `${dnsName}\n${dnsRecord}\n`, "utf8");

  console.log("\n✓ Keys written:");
  console.log(`  Private key : dkim/${domain}/private.pem`);
  console.log(`  Public key  : dkim/${domain}/public.pem`);
  console.log(`  DNS record  : dkim/${domain}/dns.txt`);
  console.log(`\nAdd this DNS TXT record to ${domain}:`);
  console.log(`  Name  : ${dnsName}`);
  console.log(`  Type  : TXT`);
  console.log(`  Value : ${dnsRecord.slice(0, 80)}…\n`);
  console.log("Then add to config.json:");
  console.log(JSON.stringify({
    dkim: {
      [domain]: {
        domainName:    domain,
        keySelector:   selector,
        privateKeyPath: `./dkim/${domain}/private.pem`,
      }
    }
  }, null, 2));
})();
