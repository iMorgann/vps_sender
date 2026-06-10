#!/usr/bin/env node
"use strict";

// ── Dependency check ──────────────────────────────────────────────────────────
(function checkDeps() {
  const required = ["nodemailer", "socks"];
  const missing  = required.filter(p => { try { require.resolve(p); return false; } catch { return true; } });
  if (missing.length) {
    console.error(`\n  ✗ Missing packages: ${missing.join(", ")}`);
    console.error(`  Run:  npm install\n`);
    process.exit(1);
  }
})();

const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const readline = require("readline");
const crypto   = require("crypto");

// ── Lib modules ───────────────────────────────────────────────────────────────
const logger             = require("./lib/logger");
const { parseProxyUrl }  = require("./lib/net/proxy");
const { runCampaign, extractEmails } = require("./lib/campaign/engine");
const { checkSenderHealth, detectSendingIp } = require("./lib/scanner/sender-health");
const { scanDomains, probePort25 } = require("./lib/scanner/domain-auth");
const { filterValid }    = require("./lib/hygiene/validator");
const { cleanList }      = require("./lib/hygiene/deduplicator");
const { exportCsv }      = require("./lib/campaign/state");

// ── DNS record builder ────────────────────────────────────────────────────────
function buildDnsRecords(domain, selector, pubDer, sendingIp) {
  const ip = sendingIp || "";
  return {
    a_root: { name: domain,            type: "A",   value: ip || "<your-server-ip>" },
    a_mail: { name: `mail.${domain}`,  type: "A",   value: ip || "<your-server-ip>" },
    mx:     { name: domain,            type: "MX",  value: `10 mail.${domain}` },
    spf:    { name: domain,            type: "TXT", value: ip ? `v=spf1 ip4:${ip} ~all` : "v=spf1 ~all" },
    dkim:   { name: `${selector}._domainkey.${domain}`, type: "TXT", value: `v=DKIM1; k=rsa; p=${pubDer}` },
    dmarc:  { name: `_dmarc.${domain}`,type: "TXT", value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}` },
  };
}

// ── Persistent config ──────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, "config.json");

function loadConfig() {
  const defaults = {
    proxyUrl:              "",
    sendingIp:             "auto",
    heloHost:              "mail.localhost",
    allowWeakDomains:      true,
    directToMxOnly:        true,
    tlsRejectUnauthorized: true,
    concurrency:           2,
    sendDelay:             1500,
    greylistWait:          60000,
    resultsFile:           "results.csv",
    apiToken:              "",
    bindHost:              "127.0.0.1",
    port:                  3000,
    domain:                "",
    transport:             "direct",
    relayHost:                  "127.0.0.1",
    relayPort:                  587,
    relayUser:                  "",
    relayPass:                  "",
    relayTlsRejectUnauthorized: false,
    relayFromEmail:             "",
    envelopeDomain:             "",
    panelDomain:                "",
    dynamicFromDomain:          "",
    preScanRelay:          true,
    dkim:                  {},
    rateLimits: {
      default:       { perMinute: 30, perHour: 500 },
      "gmail.com":   { perMinute: 10, perHour: 200 },
      "outlook.com": { perMinute: 10, perHour: 200 },
    },
    warmup: { enabled: false, dailyLimit: 100, incrementPerDay: 50 },
    unsubscribeBaseUrl: "",
  };
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return { ...defaults, ...saved };
  } catch { return defaults; }
}

let _configCache = null;
function getCachedConfig() {
  if (!_configCache) _configCache = loadConfig();
  return _configCache;
}

function saveConfig(patch) {
  const cur = loadConfig();
  _configCache = null; // invalidate cache on write
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...cur, ...patch }, null, 2));
}

// ── Proxy ──────────────────────────────────────────────────────────────────────
let PROXY = null;

// ── Web / SSE state ───────────────────────────────────────────────────────────
let webClients = [];
let engineState = {
  status: "idle",
  sent: 0, failed: 0, dropped: 0, greylisted: 0, total: 0,
  speed: 0, elapsed: 0, eta: 0, current: null,
};
let campaignCancelToken = { cancelled: false, paused: false };

// Ring-buffer so reconnecting browsers (any device) see recent activity
const recentLogs = [];         // last 150 log lines
let   lastProgress = null;     // last campaign_progress snapshot

function broadcastSSE(data) {
  if (data.type === "log") {
    recentLogs.push(data);
    if (recentLogs.length > 150) recentLogs.shift();
  } else if (data.type === "campaign_progress") {
    lastProgress = data;
  }
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  webClients = webClients.filter(res => {
    try { res.write(payload); return true; } catch { return false; }
  });
}

function updateEngineStatus(newStatus) {
  engineState.status = newStatus;
  broadcastSSE({ type: "state", status: newStatus });
}

// ── ANSI colours ───────────────────────────────────────────────────────────────
const C = { reset:"\x1b[0m", bold:"\x1b[1m", dim:"\x1b[2m", green:"\x1b[32m",
            red:"\x1b[31m", yellow:"\x1b[33m", cyan:"\x1b[36m", white:"\x1b[37m",
            bgBlue:"\x1b[44m", bgGreen:"\x1b[42m" };
const g   = s => `${C.green}${s}${C.reset}`;
const r   = s => `${C.red}${s}${C.reset}`;
const y   = s => `${C.yellow}${s}${C.reset}`;
const c   = s => `${C.cyan}${s}${C.reset}`;
const b   = s => `${C.bold}${s}${C.reset}`;
const dim = s => `${C.dim}${s}${C.reset}`;

// ── Simple readline helpers ────────────────────────────────────────────────────
function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}
function ask(rl, question, defaultVal = "") {
  return new Promise(resolve => {
    const hint = defaultVal ? dim(` [${defaultVal}]`) : "";
    rl.question(`${c("?")} ${b(question)}${hint}: `, ans => resolve(ans.trim() || defaultVal));
  });
}
function askMultiLine(rl, question) {
  return new Promise(resolve => {
    console.log(`\n${c("?")} ${b(question)}`);
    console.log(dim("  (type/paste content — end with a lone . on its own line)"));
    const lines = [];
    const onLine = line => {
      if (line === ".") { rl.removeListener("line", onLine); resolve(lines.join("\n")); }
      else lines.push(line);
    };
    rl.on("line", onLine);
  });
}

// ── File helpers ───────────────────────────────────────────────────────────────
function readLines(filepath) {
  return fs.readFileSync(filepath, "utf8")
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
}

function rot(arr, i) { return arr[i % arr.length]; }

// ── TUI file browser ──────────────────────────────────────────────────────────
function filePicker({ title = "Pick a file", multi = false, filter = null, startDir = null } = {}) {
  return new Promise(resolve => {
    let dir       = startDir || process.cwd();
    let entries   = [];
    let cursor    = 0;
    let scrollTop = 0;
    const selected = new Set();
    const VISIBLE  = 14;

    function readDir(d) {
      try {
        const raw   = fs.readdirSync(d, { withFileTypes: true });
        const dirs  = raw.filter(e => e.isDirectory()).map(e => e.name).sort();
        const files = raw.filter(e => !e.isDirectory()).map(e => e.name).sort();
        const items = [];
        if (path.resolve(d, "..") !== d)
          items.push({ name: "..", isDir: true, full: path.resolve(d, "..") });
        for (const n of dirs)
          items.push({ name: n + "/", isDir: true, full: path.join(d, n) });
        for (const n of files) {
          if (filter && !filter(n)) continue;
          items.push({ name: n, isDir: false, full: path.join(d, n) });
        }
        return items;
      } catch { return []; }
    }

    function fileSize(full) {
      try {
        const s = fs.statSync(full).size;
        if (s < 1024)        return `${s}B`;
        if (s < 1024 * 1024) return `${(s / 1024).toFixed(0)}KB`;
        return `${(s / (1024 * 1024)).toFixed(1)}MB`;
      } catch { return ""; }
    }

    function render() {
      process.stdout.write("\x1b[H\x1b[J");
      const W   = Math.max(60, (process.stdout.columns || 72));
      const bar = "─".repeat(W - 4);
      process.stdout.write(`${C.bold}${C.cyan}  ╔${bar}╗\n`);
      const hdr  = ` ${title}`.slice(0, W - 5);
      process.stdout.write(`  ║${hdr.padEnd(W - 4)}║\n`);
      const dLine = ` ${dir}`.slice(0, W - 5);
      process.stdout.write(`  ║${C.dim}${dLine.padEnd(W - 4)}${C.reset}${C.cyan}${C.bold}║\n`);
      process.stdout.write(`  ╠${bar}╣\n${C.reset}`);

      if (cursor < scrollTop) scrollTop = cursor;
      if (cursor >= scrollTop + VISIBLE) scrollTop = cursor - VISIBLE + 1;

      const slice = entries.slice(scrollTop, scrollTop + VISIBLE);
      for (let i = 0; i < slice.length; i++) {
        const e      = slice[i];
        const idx    = scrollTop + i;
        const isCursor = idx === cursor;
        const isSel  = selected.has(e.full);
        const icon   = e.isDir ? "📁" : "📄";
        const chk    = multi ? (isSel ? g("●") : dim("○")) + " " : "  ";
        const nameFmt = e.isDir ? c(e.name) : e.name;
        const sz     = e.isDir ? "" : dim(fileSize(e.full));
        const rowRaw = ` ${chk}${icon} ${nameFmt}`;
        const pad    = Math.max(0, W - 12 - e.name.length);
        const line   = `${rowRaw}${" ".repeat(pad)}${sz}`;
        if (isCursor)
          process.stdout.write(`  ${C.bgBlue}${C.white}${C.bold}▸${line.slice(0, W - 6).padEnd(W - 6)}${C.reset}\n`);
        else
          process.stdout.write(`   ${line.slice(0, W - 5)}\n`);
      }
      for (let i = slice.length; i < VISIBLE; i++) process.stdout.write("\n");
      process.stdout.write(`${C.cyan}${C.bold}  ╠${bar}╣\n${C.reset}`);
      if (multi) {
        const cnt = selected.size ? g(`${selected.size} selected`) : dim("none");
        process.stdout.write(`  ${dim("↑↓")} move  ${dim("Space")} toggle  ${dim("Enter")} confirm(${cnt})  ${dim("⌫")} up  ${dim("q")} cancel\n`);
      } else {
        process.stdout.write(`  ${dim("↑↓")} move  ${dim("Enter")} open/select  ${dim("⌫")} up  ${dim("q")} cancel\n`);
      }
    }

    function navigate(newDir) {
      dir = newDir; entries = readDir(dir); cursor = 0; scrollTop = 0; render();
    }

    entries = readDir(dir);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    render();

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners("data");
      process.stdout.write("\x1b[H\x1b[J");
    }

    process.stdin.on("data", key => {
      if (key === "q" || key === "") { cleanup(); resolve(multi ? [] : null); return; }
      if (key === "\x1b[A" || key === "k") { cursor = Math.max(0, cursor - 1); render(); return; }
      if (key === "\x1b[B" || key === "j") { cursor = Math.min(entries.length - 1, cursor + 1); render(); return; }
      if (key === "\x7f" || key === "\x08" || key === "\x1b[D") { navigate(path.resolve(dir, "..")); return; }
      if (key === " " && multi) {
        const e = entries[cursor];
        if (e && !e.isDir) { selected.has(e.full) ? selected.delete(e.full) : selected.add(e.full); cursor = Math.min(entries.length - 1, cursor + 1); }
        render(); return;
      }
      if (key === "\r" || key === "\n") {
        const e = entries[cursor];
        if (!e) return;
        if (e.isDir) { navigate(e.full); return; }
        if (multi) { cleanup(); resolve(selected.size > 0 ? [...selected] : [e.full]); }
        else        { cleanup(); resolve(e.full); }
      }
    });
  });
}

async function pickTextFile(title) {
  console.log(`\n  Opening browser — ${c(title)}\n`);
  await new Promise(r => setTimeout(r, 200));
  return filePicker({ title, multi: false, filter: n => n.endsWith(".txt") || n.endsWith(".csv") });
}
async function pickHtmlFiles(title) {
  console.log(`\n  Opening browser — ${c(title)}\n`);
  await new Promise(r => setTimeout(r, 200));
  return filePicker({ title, multi: true, filter: n => n.endsWith(".html") || n.endsWith(".htm") });
}
async function pickAttachmentFiles() {
  const SKIP = new Set([".js", ".json", ".ts", ".sh", ".yaml", ".yml", ".lock"]);
  console.log(`\n  Opening browser — ${c("Pick attachments  (Space=toggle, Enter=confirm, q=skip)")}\n`);
  await new Promise(r => setTimeout(r, 200));
  const chosen = await filePicker({
    title: "Pick attachments  —  Space toggle  Enter confirm  q skip",
    multi: true,
    filter: n => !SKIP.has(path.extname(n).toLowerCase()),
  });
  return chosen.map(full => ({ filename: path.basename(full), path: full }));
}

// ── Progress bar ───────────────────────────────────────────────────────────────
function progressBar(done, total, w = 28) {
  const fill = total ? Math.round((done / total) * w) : 0;
  const pct  = total ? Math.round((done / total) * 100) : 0;
  return `${C.cyan}${"█".repeat(fill)}${"░".repeat(w - fill)}${C.reset} ${b(pct + "%")} (${done}/${total})`;
}

// ── Banner ─────────────────────────────────────────────────────────────────────
function banner() {
  console.clear();
  console.log(`${C.bold}${C.cyan}`);
  console.log("  ╔══════════════════════════════════════════╗");
  console.log("  ║        Zetta Sends  —  Zetta Inc        ║");
  console.log("  ║   DKIM · HELO · Rate-limit · Retry      ║");
  console.log("  ║  zShell @firehol  ·  Root @irootbck     ║");
  console.log("  ╚══════════════════════════════════════════╝");
  console.log(C.reset);
}

// ── smtp.txt helpers ───────────────────────────────────────────────────────────
function saveSmtpConfig(entries, filepath) {
  const lines = [];
  entries.forEach((e, i) => {
    lines.push(`[SMTP.${i + 1}]`);
    lines.push(`enabled      = true`);
    lines.push(`host         = ${e.host}`);
    lines.push(`port         = 25`);
    lines.push(`secure       = false`);
    lines.push(`user         = `);
    lines.push(`pass         = `);
    lines.push(`fromEmail    = ${e.fromEmail}`);
    lines.push(`allowPooling = true`);
    lines.push(``);
  });
  fs.writeFileSync(filepath, lines.join("\n"), "utf8");
}

function loadSmtpConfig(filepath) {
  const text = fs.readFileSync(filepath, "utf8").replace(/^﻿/, ""); // strip UTF-8 BOM (Windows Notepad)
  const entries = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[SMTP\.\d+\]/i.test(line)) { cur = {}; entries.push(cur); continue; }
    if (!cur) continue;
    const m = line.match(/^(\w+)\s*=\s*(.*)/);
    if (m) cur[m[1].toLowerCase()] = m[2].trim();
  }
  return entries.filter(e => e.enabled !== "false" && e.host && (e.fromEmail || e.fromemail));
}

// ── Scanner CLI ────────────────────────────────────────────────────────────────
async function runScanner(cfg) {
  console.log(b("  ── Scanner: mxemails.txt → smtp.txt ──────────────────────────"));
  console.log(dim("  Reads FROM-email candidates, checks MX + SPF + DMARC + port 25\n"));

  const fromFile = await pickTextFile("Pick mxemails.txt  (FROM email candidates)");
  if (!fromFile) { console.log(r("  Cancelled.")); process.exit(0); }

  const allFromEmails = readLines(fromFile).filter(l => l.includes("@"));
  if (!allFromEmails.length) { console.log(r("  No emails found.")); process.exit(1); }

  // Build domain map
  const domainMap = {};
  for (const email of allFromEmails) {
    const d = email.split("@")[1];
    if (!d) continue;
    if (!domainMap[d]) domainMap[d] = [];
    domainMap[d].push(email);
  }
  const domains = Object.keys(domainMap);

  console.log(`\n  Scanning ${b(domains.length)} sender domain(s)…\n`);
  let done = 0;
  const results = [];
  await scanDomains(domains, PROXY, 8, (_d, _t, info) => {
    info.emails = domainMap[info.domain] || [];
    results.push(info);
    done++;
    process.stdout.write(`\r  ${c(done + "/" + domains.length)} scanned…   `);
  });
  process.stdout.write("\r" + " ".repeat(40) + "\r");

  // Show results
  const allowWeak = cfg.allowWeakDomains !== false;
  const rejected  = results.filter(d => !d.hasMx || !d.port25Open);
  const passing   = results.filter(d => d.hasMx && d.port25Open);

  if (rejected.length) {
    console.log(`\n  ${r("── Rejected ──────────────────────────────────────────────────")}`);
    for (const d of rejected) {
      const reason = !d.hasMx ? "no MX" : "port 25 blocked";
      console.log(`  ${r("✗")} ${d.domain.padEnd(32)} ${dim(reason)}`);
    }
  }

  if (!passing.length) {
    console.log(`\n  ${r("No domains passed port 25 check.")}`);
    if (cfg.allowWeakDomains) console.log(y("  Tip: Try a residential SOCKS5 proxy for port 25 access."));
    return { smtpEntries: [], outFile: null };
  }

  console.log(`\n  ${g("── Passing ───────────────────────────────────────────────────")}`);

  let smtpIdx = 0;
  for (const d of passing) {
    const authLabel = d.spfStrength === "hard" && d.dmarcPolicy !== "none"
      ? y("WARNING: strict auth — may be rejected if not your domain")
      : d.spfStrength === "none" && d.dmarcPolicy === "none"
      ? g("OPEN — no SPF/DMARC (best deliverability when you own domain)")
      : dim(`SPF:${d.spfStrength} DMARC:${d.dmarcPolicy}`);

    for (const email of (d.emails || [])) {
      smtpIdx++;
      console.log(`\n  ${c("[SMTP." + smtpIdx + "]")}  ${authLabel}`);
      console.log(`  ${dim("fromEmail =")} ${c(email)}   ${dim("host =")} ${dim(d.mx)}`);
    }
  }

  if (!allowWeak) {
    const strict = passing.filter(d => d.spfStrength === "hard" && d.dmarcPolicy !== "none");
    if (strict.length) {
      console.log(`\n  ${y("⚠  Some domains have strict auth. They'll likely reject spoofed FROM.")}`);
      console.log(dim('  Set "allowWeakDomains": true in config.json to include them anyway.\n'));
    }
  }

  const outRl = createRl();
  const outFile = await ask(outRl, "Save smtp config to", "smtp.txt");
  outRl.close();

  const smtpEntries = passing.flatMap(d => (d.emails || []).map(email => ({ host: d.mx, fromEmail: email })));
  saveSmtpConfig(smtpEntries, outFile);

  console.log(g(`\n  ✓ ${smtpEntries.length} entries saved to ${c(outFile)}\n`));
  return { smtpEntries, outFile };
}

// ── Sender CLI ─────────────────────────────────────────────────────────────────
async function runSender(smtpEntries, cfg) {
  if (!smtpEntries) {
    const smtpFile = await pickTextFile("Pick smtp.txt  (output from scanner)");
    if (!smtpFile) { console.log(r("  Cancelled.")); process.exit(0); }
    smtpEntries = loadSmtpConfig(smtpFile);
    if (!smtpEntries.length) { console.log(r("  No enabled SMTP entries found.")); process.exit(1); }
    console.log(g(`\n  ✓ ${smtpEntries.length} SMTP entries loaded`));
  }

  // Sender health check
  console.log(`\n${b("  ── Sender Health Check ───────────────────────────────────────")}`);
  const fromDomains = [...new Set(smtpEntries.map(e => (e.fromEmail || e.fromemail || "").split("@")[1]).filter(Boolean))];
  const ip = await detectSendingIp();
  console.log(dim(`  Sending IP: ${ip}`));

  for (const domain of fromDomains.slice(0, 3)) {
    const health = await checkSenderHealth(domain, ip);
    const icon   = health.status === "green" ? g("✓") : y("⚠");
    console.log(`  ${icon} ${b(domain)}`);
    for (const w of health.warnings) console.log(`     ${y("!")} ${w}`);
    for (const t of health.tips)     console.log(`     ${dim("→")} ${t}`);
  }

  // Names
  console.log(`\n${b("  ── From Names ────────────────────────────────────────────────")}`);
  const fromNamesFile = await pickTextFile("Pick names.txt  —  q to skip");
  const fromNames = fromNamesFile ? readLines(fromNamesFile) : [""];
  if (fromNamesFile) console.log(g(`\n  ✓ ${fromNames.length} name(s) loaded`));

  // Subjects
  console.log(`\n${b("  ── Subjects ──────────────────────────────────────────────────")}`);
  const subjectsFile = await pickTextFile("Pick subjects.txt");
  if (!subjectsFile) { console.log(r("  Cancelled.")); process.exit(0); }
  const subjects = readLines(subjectsFile);
  console.log(g(`\n  ✓ ${subjects.length} subject(s) loaded`));

  // Body
  console.log(`\n${b("  ── Email Body ────────────────────────────────────────────────")}`);
  console.log(`  ${c("1")}  HTML file(s)   ${c("2")}  Paste HTML   ${c("3")}  Attachment only   ${c("4")}  HTML + Attachment\n`);
  const bodyRl = createRl();
  const mode   = await ask(bodyRl, "Body mode", "1");
  bodyRl.close();

  let htmlBodies = [], attachments = [];

  if (mode === "1" || mode === "4") {
    const htmlFiles = await pickHtmlFiles("Pick HTML body file(s)");
    if (htmlFiles.length === 0) {
      const rl2  = createRl();
      const typed = await askMultiLine(rl2, "Paste HTML body (end with lone .)");
      rl2.close();
      htmlBodies = [typed];
    } else {
      htmlBodies = htmlFiles.map(f => fs.readFileSync(f, "utf8"));
      console.log(g(`\n  ✓ ${htmlBodies.length} HTML file(s) loaded`));
    }
  } else if (mode === "2") {
    const pasteRl = createRl();
    const typed   = await askMultiLine(pasteRl, "Paste HTML body");
    pasteRl.close();
    htmlBodies = [typed];
  } else {
    htmlBodies = ["<p>Please see the attached file.</p>"];
  }

  if (mode === "3" || mode === "4") {
    attachments = await pickAttachmentFiles();
    if (!attachments.length && mode === "3") { console.log(r("  No attachments. Exiting.")); process.exit(0); }
    if (attachments.length) console.log(g(`\n  ✓ ${attachments.length} attachment(s)`));
  }

  // Recipients
  console.log(`\n${b("  ── Recipients ────────────────────────────────────────────────")}`);
  const leadsFile = await pickTextFile("Pick leads file  (.txt / .csv)");
  let rawEmails;
  if (leadsFile) {
    rawEmails = extractEmails(fs.readFileSync(leadsFile, "utf8"));
    console.log(g(`\n  ✓ ${rawEmails.length} recipient(s) from ${path.basename(leadsFile)}`));
  } else {
    const pasteRl = createRl();
    const lines   = [];
    console.log(y("  Paste emails (end with lone .):"));
    await new Promise(res => {
      pasteRl.on("line", line => {
        if (line.trim() === ".") { pasteRl.close(); res(); return; }
        if (line.trim()) lines.push(line.trim());
      });
    });
    rawEmails = extractEmails(lines.join("\n"));
  }
  if (!rawEmails.length) { console.log(r("  No recipients.")); process.exit(1); }

  const { valid: validEmails, invalid } = filterValid(rawEmails);
  if (invalid.length) console.log(y(`  ⚠  ${invalid.length} invalid address(es) removed`));
  const { emails, stats: hs } = cleanList(validEmails);
  console.log(dim(`  ${hs.original} raw → ${hs.final} clean (${hs.duplicates} dups, ${hs.suppressed} suppressed)`));

  const rotRl  = createRl();
  const rotStr = await ask(rotRl, "Rotate SMTP every N sends", "2");
  rotRl.close();
  const rotEvery = parseInt(rotStr, 10) || 2;

  // Summary
  console.log(`\n${b("  ══ Summary ═══════════════════════════════════════════════════")}`);
  console.log(`  SMTP entries : ${c(smtpEntries.length + " (rotate every " + rotEvery + ")")}`);
  console.log(`  Subjects     : ${c(subjects.length + " (rotating)")}`);
  console.log(`  HTML bodies  : ${c(htmlBodies.length + " (rotating)")}`);
  console.log(`  Recipients   : ${c(emails.length)}`);
  if (attachments.length) console.log(`  Attachments  : ${c(attachments.map(a => a.filename).join(", "))}`);
  if (!cfg.tlsRejectUnauthorized) console.log(`  ${y("⚠  TLS cert validation disabled (tlsRejectUnauthorized: false)")}`);
  console.log();

  const confirmRl = createRl();
  const ok = await ask(confirmRl, "Start campaign? (yes/no)", "yes");
  confirmRl.close();
  if (!ok.toLowerCase().startsWith("y")) { console.log(y("  Cancelled.")); process.exit(0); }

  // Run campaign via shared engine
  const RESULTS_FILE = cfg.resultsFile || "results.csv";
  const csvMode      = fs.existsSync(RESULTS_FILE) ? "a" : "w";
  const csv          = fs.createWriteStream(RESULTS_FILE, { flags: csvMode });
  if (csvMode === "w") csv.write("email,from_email,subject,smtp,status,error,tls\n");

  const token = { cancelled: false, paused: false };

  // Graceful SIGTERM/SIGINT
  process.once("SIGTERM", () => { token.cancelled = true; });
  process.once("SIGINT",  () => { token.cancelled = true; });

  const stats = await runCampaign({
    smtpEntries,
    fromNames,
    subjects,
    htmlBodies,
    attachments,
    allEmails:   emails,
    config:      { ...cfg, rotEvery, _proxy: PROXY },
    csvStream:   csv,
    cancelToken: token,
    onProgress:  ({ phase, sent, failed, total, current }) => {
      if (phase === "scan") return;
      process.stdout.write(`\r  ${progressBar(sent + failed, total)}  ${dim((current?.recipient || "").slice(0,24).padEnd(24))} `);
    },
    onLog: (text, cls) => {
      if (cls === "sent")   process.stdout.write(`\r  ${g("✓")} ${text}\n`);
      else if (cls === "fail") process.stdout.write(`\r  ${r("✗")} ${text}\n`);
      else if (cls === "warn") process.stdout.write(`\r  ${y("~")} ${text}\n`);
      else if (cls === "system") console.log(`  ${dim(text)}`);
    },
  });

  await new Promise(res => csv.end(res));
  process.stdout.write(`\r  ${progressBar(stats.sent + stats.failed, (stats.sent + stats.failed + stats.dropped) || 1)}  done          \n`);

  // Final summary
  console.log(`\n${C.bold}  ╔══════════════════════════════════════════╗`);
  console.log(`  ║              Results                     ║`);
  console.log(`  ╠══════════════════════════════════════════╣`);
  console.log(`  ║  ${g("Sent       ")}${String(stats.sent).padStart(5)}                          ║`);
  console.log(`  ║  ${r("Failed     ")}${String(stats.failed).padStart(5)}                          ║`);
  console.log(`  ║  ${y("Dropped    ")}${String(stats.dropped).padStart(5)}  (port 25 blocked)      ║`);
  if (stats.greylisted) console.log(`  ║  ${y("Greylisted ")}${String(stats.greylisted).padStart(5)}  (retried)               ║`);
  console.log(`  ╠══════════════════════════════════════════╣`);
  console.log(`  ║  CSV → ${RESULTS_FILE.padEnd(34)}║`);
  console.log(`  ╚══════════════════════════════════════════╝${C.reset}\n`);
}

// ── Web GUI Server helpers (module-level to avoid per-request recreation) ─────
const TEXT_EXTS    = new Set([".txt", ".csv", ".html", ".htm"]);
const ALL_EXTS     = new Set([".txt", ".csv", ".html", ".htm", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".zip", ".docx", ".xlsx"]);
const CWD_RESOLVED = path.resolve(process.cwd());
function safeWorkspacePath(name) {
  if (!name || typeof name !== "string") return null;
  const p = path.resolve(CWD_RESOLVED, path.basename(name));
  return p.startsWith(CWD_RESOLVED + path.sep) ? p : null;
}

// ── Web GUI Server ─────────────────────────────────────────────────────────────
async function startWebServer() {
  const http   = require("http");
  const cfg    = loadConfig();
  const port   = parseInt(process.env.PORT || cfg.port || "3000", 10);
  const host   = cfg.bindHost || "127.0.0.1";

  if (cfg.proxyUrl) PROXY = parseProxyUrl(cfg.proxyUrl);

  const server = http.createServer(async (req, res) => {
    const url      = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // ── CORS (must be set before auth so OPTIONS preflight succeeds) ──────
    const origin    = req.headers.origin || "";
    const boundHost = getCachedConfig().bindHost || "127.0.0.1";
    const cfgDomain = getCachedConfig().domain   || "";
    let allowOrigin = "";
    const localhostPat = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
    if (boundHost === "127.0.0.1") {
      if (origin && !origin.match(localhostPat)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      allowOrigin = origin || "*";
    } else {
      const allowedDomains = [cfgDomain, getCachedConfig().panelDomain].filter(Boolean);
      if (allowedDomains.length) {
        const domainPats = allowedDomains.map(d => new RegExp(`^https?://${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:\\d+)?$`));
        const allowed   = !origin || origin.match(localhostPat) || domainPats.some(p => origin.match(p));
        allowOrigin = allowed ? (origin || "*") : "";
      } else {
        allowOrigin = "*";
      }
    }
    if (allowOrigin) res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Token");
    // OPTIONS preflight must return before auth — browsers never send credentials in preflight
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // ── Auth (optional API token) ──────────────────────────────────────────
    const token = getCachedConfig().apiToken;
    if (token) {
      const auth = req.headers["x-api-token"] || url.searchParams.get("token") || "";
      // Timing-safe comparison to prevent token enumeration via response time
      const tokenBuf = Buffer.from(token);
      const authBuf  = Buffer.alloc(tokenBuf.length);
      Buffer.from(auth.slice(0, tokenBuf.length)).copy(authBuf);
      const valid = auth.length === token.length && crypto.timingSafeEqual(tokenBuf, authBuf);
      if (!valid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    // ── Static assets ──────────────────────────────────────────────────────
    const staticMap = {
      "/":          ["web/index.html",  "text/html; charset=utf-8"],
      "/style.css": ["web/style.css",   "text/css; charset=utf-8"],
      "/app.js":    ["web/app.js",      "application/javascript; charset=utf-8"],
    };
    if (req.method === "GET" && staticMap[pathname]) {
      const [file, ct] = staticMap[pathname];
      res.writeHead(200, { "Content-Type": ct });
      res.end(fs.readFileSync(path.join(__dirname, file)));
      return;
    }

    // ── SSE stream ─────────────────────────────────────────────────────────
    if (req.method === "GET" && pathname === "/api/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      webClients.push(res);
      // Always send current engine state first
      res.write(`data: ${JSON.stringify({ type: "state", status: engineState.status })}\n\n`);
      // Replay last progress snapshot so a reconnecting browser restores stats/progress bar
      if (lastProgress) res.write(`data: ${JSON.stringify(lastProgress)}\n\n`);
      // Replay recent logs so the reconnecting browser sees what happened while it was away
      for (const entry of recentLogs) res.write(`data: ${JSON.stringify(entry)}\n\n`);
      req.on("close", () => { webClients = webClients.filter(c => c !== res); });
      return;
    }

    async function getJsonBody(maxBytes) {
      if (maxBytes === undefined) {
        maxBytes = pathname === "/api/files/upload" ? 15 * 1024 * 1024 : 2 * 1024 * 1024;
      }
      return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let done = false;
        req.on("data", c => {
          size += c.length;
          if (size > maxBytes) {
            done = true;
            req.destroy();
            reject(new Error("Payload too large"));
            return;
          }
          chunks.push(c);
        });
        req.on("end", () => {
          if (done) return;
          try {
            const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
            resolve(body ? JSON.parse(body) : {});
          } catch (e) { reject(e); }
        });
        req.on("error", e => { if (!done) reject(e); });
      });
    }

    try {
      // ── Health endpoint ──────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/health") {
        const logFile = require("./lib/logger").LOG_FILE;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status:    "ok",
          version:   "2.0.0",
          uptime:    process.uptime(),
          engine:    engineState.status,
          logFile,
          os:        process.platform,
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      // ── Config ─────────────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/config") {
        const config = getCachedConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          proxyUrl:              config.proxyUrl || "",
          sendDelay:             config.sendDelay ?? 1500,
          greylistWait:          config.greylistWait ?? 60000,
          resultsFile:           config.resultsFile || "results.csv",
          heloHost:              config.heloHost || "",
          allowWeakDomains:      config.allowWeakDomains !== false,
          tlsRejectUnauthorized: config.tlsRejectUnauthorized !== false,
          concurrency:           config.concurrency ?? 2,
          unsubscribeBaseUrl:    config.unsubscribeBaseUrl || "",
          bindHost:              config.bindHost || "127.0.0.1",
          port:                  config.port || 3000,
          domain:                config.domain || "",
          apiToken:              config.apiToken ? "***" : "",
          sendingIp:             config.sendingIp || "auto",
          directToMxOnly:        config.directToMxOnly !== false,
          transport:             config.transport      || "direct",
          relayHost:             config.relayHost      || "127.0.0.1",
          relayPort:             config.relayPort      || 587,
          relayUser:             config.relayUser      || "",
          relayPass:             config.relayPass      ? "***" : "",
          envelopeDomain:             config.envelopeDomain             || "",
          preScanRelay:               config.preScanRelay               !== false,
          relayTlsRejectUnauthorized: !!config.relayTlsRejectUnauthorized,
          relayFromEmail:             config.relayFromEmail             || "",
          panelDomain:                config.panelDomain                || "",
          dynamicFromDomain:          config.dynamicFromDomain          || "",
          os:                         process.platform,
          warmup: {
            enabled:         !!(config.warmup && config.warmup.enabled),
            dailyLimit:      (config.warmup && config.warmup.dailyLimit != null) ? config.warmup.dailyLimit : 100,
            incrementPerDay: (config.warmup && config.warmup.incrementPerDay != null) ? config.warmup.incrementPerDay : 50,
          },
          rateLimits: config.rateLimits || {},
          dkim:       config.dkim       || {},
        }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/config") {
        const body = await getJsonBody();
        if (body.concurrency !== undefined) {
          const c = parseInt(body.concurrency, 10);
          body.concurrency = Number.isFinite(c) && c >= 1 && c <= 100 ? c : 2;
        }
        if (body.sendDelay !== undefined) {
          const d = parseInt(body.sendDelay, 10);
          body.sendDelay = Number.isFinite(d) && d >= 0 ? d : 1500;
        }
        if (body.greylistWait !== undefined) {
          const g = parseInt(body.greylistWait, 10);
          body.greylistWait = Number.isFinite(g) && g >= 0 ? g : 60000;
        }
        if (body.bindHost !== undefined) {
          body.bindHost = body.bindHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
        }
        if (body.port !== undefined) {
          const p = parseInt(body.port, 10);
          body.port = Number.isFinite(p) && p >= 1024 && p <= 65535 ? p : 3000;
        }
        if (body.domain !== undefined) {
          body.domain = String(body.domain).replace(/[\r\n]/g, "").trim();
        }
        if (body.resultsFile !== undefined) {
          // Strip any path components — only a bare filename is allowed
          body.resultsFile = path.basename(String(body.resultsFile).trim()) || "results.csv";
        }
        if (body.apiToken === "***") {
          delete body.apiToken; // sentinel — keep existing token unchanged
        }
        if (body.tlsRejectUnauthorized !== undefined) {
          body.tlsRejectUnauthorized = !!body.tlsRejectUnauthorized;
        }
        if (body.heloHost !== undefined) {
          // Strip newlines to prevent SMTP command injection via EHLO
          body.heloHost = String(body.heloHost).replace(/[\r\n]/g, "").trim();
        }
        if (body.unsubscribeBaseUrl !== undefined) {
          body.unsubscribeBaseUrl = String(body.unsubscribeBaseUrl).replace(/[\r\n]/g, "").trim();
        }
        if (body.sendingIp !== undefined) {
          body.sendingIp = String(body.sendingIp).trim() || "auto";
        }
        if (body.directToMxOnly !== undefined) {
          body.directToMxOnly = !!body.directToMxOnly;
        }
        if (body.transport !== undefined) {
          body.transport = body.transport === "relay" ? "relay" : "direct";
        }
        if (body.relayHost !== undefined) {
          body.relayHost = String(body.relayHost).replace(/[\r\n]/g, "").trim() || "127.0.0.1";
        }
        if (body.relayPort !== undefined) {
          const rp = parseInt(body.relayPort, 10);
          body.relayPort = Number.isFinite(rp) && rp >= 1 && rp <= 65535 ? rp : 587;
        }
        if (body.relayUser !== undefined) {
          body.relayUser = String(body.relayUser).replace(/[\r\n]/g, "").trim();
        }
        if (body.relayPass !== undefined) {
          if (body.relayPass === "***") delete body.relayPass;
          else body.relayPass = String(body.relayPass);
        }
        if (body.envelopeDomain !== undefined) {
          body.envelopeDomain = String(body.envelopeDomain).replace(/[\r\n]/g, "").trim().toLowerCase();
        }
        if (body.panelDomain !== undefined) {
          body.panelDomain = String(body.panelDomain).replace(/[\r\n]/g, "").trim().toLowerCase();
        }
        if (body.relayTlsRejectUnauthorized !== undefined) {
          body.relayTlsRejectUnauthorized = !!body.relayTlsRejectUnauthorized;
        }
        if (body.relayFromEmail !== undefined) {
          body.relayFromEmail = String(body.relayFromEmail).replace(/[\r\n]/g, "").trim();
        }
        if (body.preScanRelay !== undefined) {
          body.preScanRelay = !!body.preScanRelay;
        }
        if (body.allowWeakDomains !== undefined) {
          body.allowWeakDomains = !!body.allowWeakDomains;
        }
        if (body.warmup !== undefined) {
          if (typeof body.warmup === "object" && body.warmup !== null && !Array.isArray(body.warmup)) {
            body.warmup = {
              enabled:         !!body.warmup.enabled,
              dailyLimit:      Math.max(1, parseInt(body.warmup.dailyLimit, 10) || 100),
              incrementPerDay: Math.max(1, parseInt(body.warmup.incrementPerDay, 10) || 50),
            };
          } else { delete body.warmup; }
        }
        if (body.rateLimits !== undefined) {
          if (typeof body.rateLimits !== "object" || Array.isArray(body.rateLimits) || body.rateLimits === null) {
            delete body.rateLimits;
          }
        }
        if (body.dkim !== undefined) {
          if (typeof body.dkim !== "object" || Array.isArray(body.dkim) || body.dkim === null) {
            delete body.dkim;
          }
        }
        if (body.proxyUrl !== undefined) {
          body.proxyUrl = String(body.proxyUrl).replace(/[\r\n]/g, "").trim();
        }
        saveConfig(body);
        if (body.proxyUrl !== undefined) PROXY = body.proxyUrl ? parseProxyUrl(body.proxyUrl) : null;
        if (body.bindHost === "0.0.0.0" && !getCachedConfig().apiToken) {
          logger.warn("public_binding_no_token", { msg: "GUI bound to 0.0.0.0 with no API token — anyone can access it" });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // ── Proxy test ───────────────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/proxy/test") {
        const body      = await getJsonBody();
        const testProxy = parseProxyUrl(body.proxyUrl);
        let success = false, errorMsg = "";
        if (!testProxy) {
          errorMsg = "Invalid proxy format";
        } else {
          try {
            const { SocksClient } = require("socks");
            const info = await SocksClient.createConnection({
              proxy:       { host: testProxy.host, port: testProxy.port, type: testProxy.type, userId: testProxy.userId, password: testProxy.password },
              command:     "connect",
              destination: { host: "8.8.8.8", port: 53 },
              timeout:     8000,
            });
            info.socket.destroy();
            success = true;
          } catch (e) { errorMsg = e.message; }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success, message: success ? "Connection successful" : null, error: errorMsg }));
        return;
      }

      // ── File API ─────────────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/files") {
        const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
        const textFiles   = entries.filter(e => e.isFile() && TEXT_EXTS.has(path.extname(e.name).toLowerCase())).map(e => e.name);
        const binaryFiles = entries.filter(e => e.isFile() && !TEXT_EXTS.has(path.extname(e.name).toLowerCase()) &&
                                                 ALL_EXTS.has(path.extname(e.name).toLowerCase()))
                                   .map(e => {
                                     const stat = fs.statSync(path.join(process.cwd(), e.name));
                                     return { name: e.name, size: stat.size };
                                   });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          files: textFiles,
          attachments: binaryFiles,
          campaignWizard: {
            fromNameOverride: webCampaignConfig.fromNameOverride || "",
            replyTo:          webCampaignConfig.replyTo          || "",
            fromEmailOverride: webCampaignConfig.fromEmailOverride || "",
            dynamicFromDomain: webCampaignConfig.dynamicFromDomain || "",
          },
        }));
        return;
      }

      if (req.method === "GET" && pathname === "/api/files/read") {
        const name     = url.searchParams.get("name");
        const filepath = safeWorkspacePath(name);
        if (!filepath || !TEXT_EXTS.has(path.extname(filepath).toLowerCase())) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid filename" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: fs.existsSync(filepath) ? fs.readFileSync(filepath, "utf8") : "" }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/files/save") {
        const body = await getJsonBody();
        const { name, content } = body;
        const filepath = safeWorkspacePath(name);
        if (!filepath || !TEXT_EXTS.has(path.extname(filepath).toLowerCase())) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid filename" }));
          return;
        }
        if (typeof content !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "content must be a string" }));
          return;
        }
        fs.writeFileSync(filepath, content, "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.method === "GET" && pathname === "/api/files/download") {
        const name     = url.searchParams.get("name");
        const filepath = safeWorkspacePath(name);
        if (!filepath || !ALL_EXTS.has(path.extname(filepath).toLowerCase()) || !fs.existsSync(filepath)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File not found" }));
          return;
        }
        const safeName = path.basename(filepath).replace(/"/g, "");
        res.writeHead(200, {
          "Content-Type":        "application/octet-stream",
          "Content-Disposition": `attachment; filename="${safeName}"`,
          "Content-Length":      fs.statSync(filepath).size,
        });
        fs.createReadStream(filepath).pipe(res);
        return;
      }

      if (req.method === "POST" && pathname === "/api/files/upload") {
        const body = await getJsonBody(); // up to 15 MB for this route
        const { name, data, encoding } = body;
        const filepath = safeWorkspacePath(name);
        if (!filepath || !ALL_EXTS.has(path.extname(filepath).toLowerCase())) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid filename or extension" }));
          return;
        }
        if (typeof data !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "data must be a string" }));
          return;
        }
        if (encoding === "base64") {
          fs.writeFileSync(filepath, Buffer.from(data, "base64"));
        } else {
          fs.writeFileSync(filepath, data, "utf8");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/files/delete") {
        const body     = await getJsonBody();
        const filepath = safeWorkspacePath(body.name);
        if (!filepath || !ALL_EXTS.has(path.extname(filepath).toLowerCase()) || !fs.existsSync(filepath)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File not found" }));
          return;
        }
        fs.unlinkSync(filepath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // ── Export CSV ───────────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/export-csv") {
        const campaignId = url.searchParams.get("campaign") || "default";
        const csvData    = exportCsv(campaignId);
        if (!csvData) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No data for that campaign" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="campaign-${campaignId}.csv"` });
        res.end(csvData);
        return;
      }

      // ── Scanner ──────────────────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/scan") {
        if (engineState.status !== "idle") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Engine busy" }));
          return;
        }
        recentLogs.length = 0;
        lastProgress      = null;
        const body = await getJsonBody();
        const rawFile = safeWorkspacePath(body.file);
        if (!rawFile) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid or missing source file" }));
          return;
        }
        const rawOutput  = (body.output && body.output.trim()) ? body.output.trim() : "smtp.txt";
        const outputFile = safeWorkspacePath(rawOutput) || safeWorkspacePath("smtp.txt");
        if (!outputFile) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid output path" }));
          return;
        }
        campaignCancelToken = { cancelled: false, paused: false }; // reset so a prior stop doesn't immediately abort the scan
        const allFromEmails  = readLines(rawFile).filter(l => l.includes("@"));
        runWebScanner(allFromEmails, body.includeWeak, outputFile).catch(err => {
          broadcastSSE({ type: "log", text: `Scan error: ${err.message}`, logClass: "fail" });
          updateEngineStatus("idle");
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // ── Sender health check ──────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/sender-health") {
        const body   = await getJsonBody();
        const domain = body.domain;
        if (!domain) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "domain required" })); return; }
        const health = await checkSenderHealth(domain, null, body.selector || "mail");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
        return;
      }

      // ── Campaign ─────────────────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/campaign/setup") {
        const body = await getJsonBody();
        const cwd  = path.resolve(process.cwd());
        const sep  = path.sep;
        function safeFilePath(raw) {
          if (!raw || typeof raw !== "string") return null;
          const r = path.resolve(cwd, raw);
          return r.startsWith(cwd + sep) ? r : null;
        }
        const safe = {};
        // "direct" is the wizard sentinel for "no SMTP file — use direct-to-MX"; must NOT be path-resolved
        if (body.smtpFile !== undefined) safe.smtpFile = body.smtpFile === "direct" ? "direct" : (safeFilePath(body.smtpFile) || webCampaignConfig.smtpFile);
        if (body.recipientsFile  !== undefined) safe.recipientsFile  = safeFilePath(body.recipientsFile)  || webCampaignConfig.recipientsFile;
        if (body.namesFile       !== undefined) safe.namesFile       = body.namesFile === "" ? "" : (safeFilePath(body.namesFile) || webCampaignConfig.namesFile);
        if (body.subjectsFile    !== undefined) safe.subjectsFile    = safeFilePath(body.subjectsFile)    || webCampaignConfig.subjectsFile;
        if (body.htmlFiles       !== undefined) {
          const validated = (Array.isArray(body.htmlFiles) ? body.htmlFiles : []).map(safeFilePath).filter(Boolean);
          safe.htmlFiles = validated.length ? validated : webCampaignConfig.htmlFiles;
        }
        if (body.attachmentFiles !== undefined) {
          safe.attachmentFiles = (Array.isArray(body.attachmentFiles) ? body.attachmentFiles : []).map(safeFilePath).filter(Boolean);
        }
        if (body.rotEvery          !== undefined) safe.rotEvery          = parseInt(body.rotEvery, 10) || 2;
        if (body.resume            !== undefined) safe.resume            = !!body.resume;
        if (body.domainRotation    !== undefined) safe.domainRotation    = !!body.domainRotation;
        if (body.dynamicFromDomain !== undefined) safe.dynamicFromDomain = String(body.dynamicFromDomain || "").replace(/[\r\n]/g, "").trim().toLowerCase();
        if (body.fromEmailOverride !== undefined) safe.fromEmailOverride = String(body.fromEmailOverride || "").replace(/[\r\n]/g, "").trim();
        if (body.fromNameOverride  !== undefined) safe.fromNameOverride  = String(body.fromNameOverride  || "").replace(/[\r\n"\\]/g, "").trim();
        if (body.replyTo           !== undefined) safe.replyTo           = String(body.replyTo           || "").replace(/[\r\n]/g, "").trim();
        Object.assign(webCampaignConfig, safe);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/campaign/start") {
        if (engineState.status !== "idle") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Engine busy" }));
          return;
        }
        recentLogs.length = 0;
        lastProgress      = null;
        engineState       = { status: "idle", sent: 0, failed: 0, dropped: 0, greylisted: 0, total: 0, speed: 0, elapsed: 0, eta: 0, current: null };
        campaignCancelToken = { cancelled: false, paused: false };
        runWebCampaign().catch(err => {
          broadcastSSE({ type: "log", text: `Campaign error: ${err.message}`, logClass: "fail" });
          updateEngineStatus("idle");
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/campaign/pause") {
        if (engineState.status === "sending") {
          campaignCancelToken.paused = true;
          updateEngineStatus("paused");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/campaign/resume") {
        if (engineState.status !== "paused") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not paused" }));
          return;
        }
        campaignCancelToken.paused = false;
        updateEngineStatus("sending");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/campaign/stop") {
        campaignCancelToken.cancelled = true;
        campaignCancelToken.paused    = false;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // ── Test send ────────────────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/test-send") {
        const body   = await getJsonBody();
        const toAddr = String(body.to || "").replace(/[\r\n]/g, "").trim();
        if (!toAddr || !toAddr.includes("@")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid recipient address" }));
          return;
        }
        const cfg = getCachedConfig();
        const { getTransport } = require("./lib/delivery/transport");
        const { buildMailOptions, randomLocalPart } = require("./lib/mime/builder");
        const deliver = getTransport(cfg);

        let smtpEntry = null;
        if (webCampaignConfig.smtpFile && webCampaignConfig.smtpFile !== "direct") {
          try {
            const entries = loadSmtpConfig(webCampaignConfig.smtpFile);
            if (entries.length) smtpEntry = entries[0];
          } catch { /* fall through */ }
        }
        const fallbackDomain = cfg.heloHost || cfg.domain || "example.com";
        const smtpFrom = smtpEntry ? (smtpEntry.fromEmail || smtpEntry.fromemail || `test@${fallbackDomain}`) : `test@${fallbackDomain}`;
        const fromEmail = webCampaignConfig.fromEmailOverride
          ? webCampaignConfig.fromEmailOverride
          : webCampaignConfig.dynamicFromDomain
            ? `${randomLocalPart()}@${webCampaignConfig.dynamicFromDomain}`
            : smtpFrom;

        let mime;
        try {
          mime = buildMailOptions({
            to: toAddr, fromEmail, fromName: "Test Send",
            subject: "Test Email — VPS Sender",
            html: "<p>This is a test email sent from your VPS Sender panel.</p>",
            attachments: [], config: cfg, templateVars: { email: toAddr, domain: toAddr.split("@")[1], name: "Test" },
          });
        } catch (buildErr) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "MIME build failed: " + buildErr.message }));
          return;
        }

        try {
          const mxDomain = toAddr.split("@")[1];
          const result = await deliver(toAddr, mxDomain, mime, fromEmail, cfg.heloHost || "mail.localhost", {
            tlsRejectUnauthorized: cfg.tlsRejectUnauthorized !== false,
            relayHost:                cfg.relayHost || "127.0.0.1",
            relayPort:                cfg.relayPort || 587,
            relayUser:                cfg.relayUser || "",
            relayPass:                cfg.relayPass || "",
            relayTlsRejectUnauthorized: cfg.relayTlsRejectUnauthorized ?? false,
            relayFromEmail:           cfg.relayFromEmail || "",
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, tls: result.tls, from: fromEmail, to: toAddr }));
        } catch (sendErr) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: sendErr.message }));
        }
        return;
      }

      // ── IP Blacklist / RBL check ─────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/blacklist-check") {
        const { checkAllBlacklists } = require("./lib/scanner/blacklist");
        let ip = "";
        try { ip = await detectSendingIp(); } catch { /* ignore */ }
        const result = await checkAllBlacklists(ip);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && pathname === "/api/campaign/clear-history") {
        const { getDb } = require("./lib/campaign/state");
        const db = getDb();
        if (db) db.prepare("DELETE FROM campaign_results").run();
        const csvPath = config.resultsFile || "results.csv";
        if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── Postfix mail queue ───────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/postfix/queue") {
        const { execFile } = require("child_process");
        execFile("postqueue", ["-j"], (err, stdout) => {
          if (err) {
            // postqueue -j unavailable — fall back to mailq text
            execFile("mailq", [], (err2, stdout2) => {
              if (err2) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ queue: [], error: err2.code === "ENOENT" ? "Postfix not installed or not in PATH" : err2.message }));
                return;
              }
              // Parse minimal info from mailq text: queue is empty or has entries
              const empty = /Mail queue is empty/i.test(stdout2);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ queue: [], rawText: empty ? "" : stdout2.trim(), count: empty ? 0 : -1 }));
            });
            return;
          }
          const lines = stdout.trim().split("\n").filter(Boolean);
          const queue = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ queue, count: queue.length }));
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/postfix/flush") {
        const { execFile } = require("child_process");
        execFile("postqueue", ["-f"], (err) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: !err, error: err ? err.message : null }));
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/postfix/logs") {
        const logCandidates = ["/var/log/mail.log", "/var/log/maillog"];
        let lines = [];
        for (const lp of logCandidates) {
          if (fs.existsSync(lp)) {
            try {
              const data = fs.readFileSync(lp, "utf8");
              lines = data.split("\n").filter(Boolean).slice(-200);
              break;
            } catch { /* permission denied — try journalctl */ }
          }
        }
        if (lines.length === 0) {
          const { execFile } = require("child_process");
          try {
            await new Promise((resolve) => {
              execFile("journalctl", ["-u", "postfix", "-n", "200", "--no-pager", "--output=cat"], (err, stdout) => {
                if (!err) lines = stdout.split("\n").filter(Boolean);
                resolve();
              });
            });
          } catch { /* ignore */ }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ lines, count: lines.length }));
        return;
      }

      {
        const queueDelMatch = pathname.match(/^\/api\/postfix\/queue\/([A-Za-z0-9]{8,20})$/);
        if (req.method === "DELETE" && queueDelMatch) {
          const qid = queueDelMatch[1];
          const { execFile } = require("child_process");
          execFile("postsuper", ["-d", qid], (err) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: !err, error: err ? err.message : null }));
          });
          return;
        }
      }

      // ── DKIM key generation ──────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/dkim/generate") {
        const body     = await getJsonBody();
        const domain   = String(body.domain || "").replace(/[\r\n]/g, "").trim().toLowerCase();
        if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid domain" }));
          return;
        }
        const selector = String(body.selector || "mail").replace(/[^a-z0-9]/g, "") || "mail";
        const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
        const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
        const pubDer  = publicKey.export({ type: "spki", format: "der" }).toString("base64").replace(/\n/g, "");

        const dkimDir = path.join(__dirname, "dkim");
        if (!fs.existsSync(dkimDir)) fs.mkdirSync(dkimDir, { mode: 0o700 });
        fs.writeFileSync(path.join(dkimDir, `${domain}.pem`), privPem, { mode: 0o600 });

        const cfg  = loadConfig();
        const dkim = { ...(cfg.dkim || {}) };
        dkim[domain] = { domainName: domain, keySelector: selector, privateKeyPath: `dkim/${domain}.pem` };
        saveConfig({ dkim });

        let sendingIp = "";
        try { sendingIp = await detectSendingIp(); } catch { /* ignore */ }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success:   true,
          domain,
          selector,
          publicKey: pubDer,
          dns: buildDnsRecords(domain, selector, pubDer, sendingIp),
          os: process.platform,
        }));
        return;
      }

      // ── Domain management ────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/domains") {
        const cfg  = getCachedConfig();
        const dkim = cfg.dkim || {};
        const list = Object.entries(dkim).map(([domain, d]) => ({
          domain,
          selector: d.keySelector || "mail",
          keyFile:  d.privateKeyPath || `dkim/${domain}.pem`,
          hasKey:   fs.existsSync(path.join(__dirname, d.privateKeyPath || `dkim/${domain}.pem`)),
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
        return;
      }

      if (req.method === "POST" && pathname === "/api/domains/delete") {
        const body   = await getJsonBody();
        const domain = String(body.domain || "").replace(/[\r\n]/g, "").trim().toLowerCase();
        if (!domain) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing domain" }));
          return;
        }
        const cfg  = loadConfig();
        const dkim = { ...(cfg.dkim || {}) };
        const entry = dkim[domain];
        if (entry && body.deleteKey) {
          const keyPath = path.join(__dirname, entry.privateKeyPath || `dkim/${domain}.pem`);
          if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
        }
        delete dkim[domain];
        saveConfig({ dkim });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      const domainDnsMatch = pathname.match(/^\/api\/domains\/([^/]+)\/dns$/);
      if (req.method === "GET" && domainDnsMatch) {
        const domain = decodeURIComponent(domainDnsMatch[1]).toLowerCase();
        const cfg    = getCachedConfig();
        const entry  = (cfg.dkim || {})[domain];
        if (!entry) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Domain not found" }));
          return;
        }
        const keyPath = path.join(__dirname, entry.privateKeyPath || `dkim/${domain}.pem`);
        if (!fs.existsSync(keyPath)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Key file not found" }));
          return;
        }
        const privPem  = fs.readFileSync(keyPath, "utf8");
        const privKey  = crypto.createPrivateKey(privPem);
        const pubKey   = crypto.createPublicKey(privKey);
        const pubDer   = pubKey.export({ type: "spki", format: "der" }).toString("base64").replace(/\n/g, "");
        const selector = entry.keySelector || "mail";
        let sendingIp  = "";
        try { sendingIp = await detectSendingIp(); } catch { /* ignore */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          domain,
          selector,
          dns: buildDnsRecords(domain, selector, pubDer, sendingIp),
        }));
        return;
      }

      // ── PM2 restart ─────────────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/server/restart") {
        // Prefer app name ("vps-sender") over numeric ID — matches `pm2 restart vps-sender`
        const pmName = process.env.name;
        const pmId   = process.env.pm_id;
        const target = pmName ?? pmId;
        if (target === undefined || target === null) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not running under PM2 — restart the process manually." }));
          return;
        }
        const { execFile } = require("child_process");
        // Locate pm2 binary safely — prefer the one on PATH
        const pm2Bin = process.platform === "win32" ? "pm2.cmd" : "pm2";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: `Restarting PM2 process ${target}…` }));
        // Delay slightly so the HTTP response flushes before the process restarts
        setTimeout(() => {
          execFile(pm2Bin, ["restart", String(target)], { timeout: 10_000 }, (err) => {
            if (err) logger.warn("pm2_restart_failed", { target, error: err.message });
            else     logger.info("pm2_restarted",       { target });
          });
        }, 400);
        return;
      }

      // ── Relay health check ───────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/relay/health") {
        const config    = getCachedConfig();
        const transport = config.transport || "direct";
        const rHost     = config.relayHost || "127.0.0.1";
        const rPort     = config.relayPort || 587;
        const platform  = process.platform;

        // TCP connection test
        const connResult = await new Promise(resolve => {
          const net   = require("net");
          const sock  = new net.Socket();
          const timer = setTimeout(() => { sock.destroy(); resolve({ ok: false, error: "timeout after 5s" }); }, 5000);
          sock.connect(rPort, rHost, () => { clearTimeout(timer); sock.destroy(); resolve({ ok: true }); });
          sock.on("error", e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
        });

        const mta = { detected: null, active: false, details: {}, issues: [], warnings: [] };
        const { execFile } = require("child_process");
        const sh  = platform === "win32" ? ["cmd", ["/c"]] : ["/bin/sh", ["-c"]];
        const run = cmd => new Promise(r => execFile(sh[0], [...sh[1], cmd], { timeout: 5000 }, (_e, out) => r((out || "").trim())));

        if (platform === "linux") {
          const [svc, iface, nets, port25] = await Promise.all([
            run("systemctl is-active postfix 2>/dev/null || echo inactive"),
            run("postconf -h inet_interfaces 2>/dev/null || echo unknown"),
            run("postconf -h mynetworks 2>/dev/null || echo unknown"),
            run("ss -tlnp 'sport = :25' 2>/dev/null | tail -n +2 | head -3 || echo ''"),
          ]);
          mta.detected = "postfix";
          mta.active   = svc === "active";
          mta.details  = { service: svc, inet_interfaces: iface, mynetworks: nets, port25_listeners: port25 || "(none)" };
          if (!mta.active) mta.issues.push("Postfix is not running. Fix: sudo systemctl start postfix && sudo systemctl enable postfix");
          if (iface !== "unknown" && !iface.includes("loopback") && !iface.includes("127.0.0.1"))
            mta.warnings.push(`inet_interfaces = "${iface}" — expected "loopback-only" to restrict to localhost`);
          if (nets !== "unknown" && !nets.includes("127.0.0.0") && !nets.includes("127.0.0.1"))
            mta.warnings.push(`mynetworks = "${nets}" — 127.0.0.0/8 should be included to trust loopback relay`);
        } else if (platform === "darwin") {
          const [iface, launchd] = await Promise.all([
            run("postconf -h inet_interfaces 2>/dev/null || echo unknown"),
            run("launchctl list 2>/dev/null | grep postfix || echo ''"),
          ]);
          mta.detected = "postfix";
          mta.active   = launchd.includes("postfix");
          mta.details  = { service: mta.active ? "running (launchctl)" : "not running", inet_interfaces: iface };
          if (!mta.active) mta.issues.push("Postfix is not running on macOS. Fix: sudo postfix start");
        } else if (platform === "win32") {
          const svcOut = await run("sc query hMailServer 2>nul");
          if (svcOut && !svcOut.toLowerCase().includes("does not exist")) {
            mta.detected = "hmailserver";
            mta.active   = svcOut.includes("RUNNING");
            const m = svcOut.match(/STATE\s*:\s*\d+\s+([A-Z_]+)/);
            mta.details.service = m ? m[1] : svcOut.slice(0, 80).trim();
            if (!mta.active) mta.issues.push("hMailServer service is not running. Start it via Windows Services or hMailServer Admin.");
            mta.warnings.push("Verify: hMailServer Admin → Settings → Advanced → IP Ranges → 127.0.0.1 must allow relay without authentication.");
          } else {
            mta.issues.push("hMailServer service not found. Download from hmailserver.com, install it, create a domain, and add an IP Range rule for 127.0.0.1 to allow relay on port 587 without auth.");
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ os: platform, transport, relayHost: rHost, relayPort: rPort, connection: connResult, mta }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (e) {
      logger.error("request_error", { path: pathname, error: e.message });
      const status = e.message === "Payload too large" ? 413 : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.listen(port, host, async () => {
    const localUrl   = `http://localhost:${port}`;
    const panelDom   = getCachedConfig().panelDomain;
    const smtpDomain = getCachedConfig().domain;
    const bindUrl    = host === "0.0.0.0"
      ? (panelDom ? `http://${panelDom}` : smtpDomain ? `http://${smtpDomain}:${port}` : `http://<server-ip>:${port}`)
      : localUrl;
    console.log(`\n  ${g("✓")} ${b("Web GUI running at:")} ${c(localUrl)}`);
    if (host === "0.0.0.0") {
      console.log(`  ${g("✓")} ${b("Public URL:")} ${c(bindUrl)}`);
      if (panelDom) console.log(`  ${g("✓")} ${b("Panel domain:")} ${c(panelDom)} ${"\x1b[90m"}(add A record → your VPS IP)${"\x1b[0m"}`);
      if (!getCachedConfig().apiToken) {
        console.log(`\n  ${"\x1b[33m"}⚠  No API token set — GUI is open to the internet!${"\x1b[0m"}`);
        console.log(`  Set one via Settings in the web UI or in config.json.\n`);
      }
    }
    console.log("");
    logger.info("server_started", { host, port, public: host === "0.0.0.0" });

    // Cross-platform browser open (only when binding to localhost)
    if (host === "127.0.0.1") {
      try {
        const open = require("open");
        await open(localUrl);
      } catch {
        try { require("child_process").exec(`start ${localUrl}`); } catch { /**/ }
      }
    }
  });

  // Graceful shutdown
  function gracefulShutdown(signal) {
    console.log(`\n  ${y(signal + " received — finishing current email…")}`);
    campaignCancelToken.cancelled = true;
    setTimeout(() => {
      server.close(() => { console.log("  Server closed."); process.exit(0); });
    }, 3000);
  }
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.once("SIGINT",  () => gracefulShutdown("SIGINT"));
}

// ── Web campaign config ────────────────────────────────────────────────────────
let webCampaignConfig = {
  recipientsFile:    "recipients.txt",
  namesFile:         "names.txt",
  subjectsFile:      "subjects.txt",
  htmlFiles:         ["body.html"],
  attachmentFiles:   [],
  smtpFile:          "smtp.txt",
  rotEvery:          2,
  resume:            true,
  domainRotation:    false,
  dynamicFromDomain: "",
  fromEmailOverride: "",
  fromNameOverride:  "",
  replyTo:           "",
};

async function runWebScanner(emails, includeWeak, outputFile) {
  updateEngineStatus("scanning");
  const domainMap = {};
  for (const email of emails) {
    const d = email.split("@")[1];
    if (d) { if (!domainMap[d]) domainMap[d] = []; domainMap[d].push(email); }
  }
  const domains = Object.keys(domainMap);

  broadcastSSE({ type: "log", text: `Scanning ${domains.length} domains…`, logClass: "system" });

  const results = [];
  await scanDomains(domains, PROXY, 8, (_done, _total, info) => {
    info.emails = domainMap[info.domain] || [];
    results.push(info);
    broadcastSSE({ type: "scan_progress", results, done: false });
  }, campaignCancelToken);

  const passing = results.filter(d => {
    if (!d.hasMx || !d.port25Open) return false;
    // When includeWeak is false, exclude domains with STRICT enforcement (hard SPF + DMARC policy).
    // Those domains would reject mail from unauthorized IPs — only keep open/soft domains.
    // Matches CLI behaviour: allowWeakDomains=false warns about strict-auth, doesn't include them.
    if (!includeWeak && d.spfStrength === "hard" && d.dmarcPolicy !== "none") return false;
    return true;
  });
  const smtpEntries = passing.flatMap(d => (d.emails || []).map(email => ({ host: d.mx, fromEmail: email })));
  saveSmtpConfig(smtpEntries, outputFile);

  broadcastSSE({ type: "scan_progress", results, done: true, entriesSaved: smtpEntries.length });
  updateEngineStatus("idle");
}

async function runWebCampaign() {
  updateEngineStatus("sending");
  const cfg = getCachedConfig();

  // "direct" is the UI sentinel for "no smtp.txt selected yet"
  if (!webCampaignConfig.smtpFile || webCampaignConfig.smtpFile === "direct") {
    broadcastSSE({ type: "log", text: "No SMTP file selected. Run the Domain Scanner first, then select smtp.txt in the Campaign Wizard.", logClass: "fail" });
    updateEngineStatus("idle");
    return;
  }

  const smtpEntries = loadSmtpConfig(webCampaignConfig.smtpFile);
  if (!smtpEntries.length) {
    broadcastSSE({ type: "log", text: "No enabled SMTP configurations.", logClass: "fail" });
    updateEngineStatus("idle");
    return;
  }

  let fromNames, subjects, htmlBodies, attachments, allEmails;
  try {
    fromNames   = webCampaignConfig.namesFile ? readLines(webCampaignConfig.namesFile) : [""];
    subjects    = readLines(webCampaignConfig.subjectsFile);
    htmlBodies  = (webCampaignConfig.htmlFiles || []).map(f => fs.readFileSync(f, "utf8"));
    attachments = (webCampaignConfig.attachmentFiles || []).map(f => ({ filename: path.basename(f), path: f }));
    allEmails   = extractEmails(fs.readFileSync(webCampaignConfig.recipientsFile, "utf8"));
  } catch (e) {
    broadcastSSE({ type: "log", text: `File load error: ${e.message}`, logClass: "fail" });
    updateEngineStatus("idle");
    return;
  }

  if (!subjects.length) {
    broadcastSSE({ type: "log", text: `${webCampaignConfig.subjectsFile} has no subject lines — add at least one subject.`, logClass: "fail" });
    updateEngineStatus("idle");
    return;
  }
  if (!htmlBodies.length) {
    broadcastSSE({ type: "log", text: "No HTML body files selected — check at least one HTML template in the Campaign Wizard.", logClass: "fail" });
    updateEngineStatus("idle");
    return;
  }
  if (!allEmails.length) {
    broadcastSSE({ type: "log", text: `No valid email addresses found in ${webCampaignConfig.recipientsFile}.`, logClass: "fail" });
    updateEngineStatus("idle");
    return;
  }

  // Use a stable ID derived from config so resume works across sessions.
  // A fresh timestamp ID is used only when resume is explicitly disabled.
  const campaignId = webCampaignConfig.resume
    ? `web-${webCampaignConfig.recipientsFile}-${webCampaignConfig.smtpFile}`.replace(/[^a-z0-9._-]/gi, "_")
    : `web-${Date.now()}`;

  // Build domain rotation pool from configured DKIM entries that have key files on disk
  const domainPool = webCampaignConfig.domainRotation
    ? Object.entries(cfg.dkim || {})
        .filter(([domain, d]) => fs.existsSync(path.join(__dirname, d.privateKeyPath || `dkim/${domain}.pem`)))
        .map(([domain]) => domain)
    : [];

  if (webCampaignConfig.domainRotation) {
    if (domainPool.length === 0) {
      broadcastSSE({ type: "log", text: "Domain rotation is enabled but no configured domains have key files. Add domains in the Sending Domains tab.", logClass: "warn" });
    } else {
      broadcastSSE({ type: "log", text: `Domain rotation: using ${domainPool.length} domain(s): ${domainPool.join(", ")}`, logClass: "system" });
    }
  }

  const stats = await runCampaign({
    smtpEntries,
    fromNames,
    subjects,
    htmlBodies,
    attachments,
    allEmails,
    domainPool,
    config:      { ...cfg, rotEvery: webCampaignConfig.rotEvery, dynamicFromDomain: webCampaignConfig.dynamicFromDomain || "", fromEmailOverride: webCampaignConfig.fromEmailOverride || "", fromNameOverride: webCampaignConfig.fromNameOverride || "", replyTo: webCampaignConfig.replyTo || "", _proxy: PROXY },
    campaignId,
    cancelToken: campaignCancelToken,
    onProgress: s => {
      if (s.phase === "scan") {
        broadcastSSE({ type: "scan_progress", done: false });
        return;
      }
      engineState = { ...engineState, ...s };
      broadcastSSE({ type: "campaign_progress", stats: s, speed: s.speed, elapsed: s.elapsed, eta: s.eta, current: s.current });
    },
    onLog: (text, logClass) => broadcastSSE({ type: "log", text, logClass }),
  });

  const newSent   = stats.sent;
  const totalSent = newSent + (stats.alreadySent || 0);
  broadcastSSE({
    type: "campaign_progress",
    stats: {
      ...stats,
      sent:      totalSent,                         // cumulative (new + resumed)
      reachable: totalSent + stats.failed,          // denominator must match sent so pct ≤ 100
      total:     totalSent + stats.failed + stats.dropped,
    },
    speed:   0,
    elapsed: 0,
    eta:     0,
    current: null,
    done:    true,
  });
  updateEngineStatus("idle");
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--gui") || args.includes("--web")) {
    await startWebServer();
    return;
  }

  banner();
  const cfg = loadConfig();

  // Proxy setup
  {
    const envProxy = process.env.PROXY_URL || cfg.proxyUrl || "";
    const masked   = envProxy ? envProxy.replace(/:\/\/.*@/, "://*****@") : "";
    console.log(b("  ── Proxy ─────────────────────────────────────────────────────"));
    console.log(dim("  OPTIONAL — leave blank for direct connect. Format: socks5://user:pass@host:port"));
    if (masked) console.log(dim(`  Saved: ${masked}  (Enter to reuse, 'none' to clear)\n`));
    else        console.log(dim("  No saved proxy\n"));
    const proxyRl    = createRl();
    const proxyInput = await ask(proxyRl, "Proxy URL (or Enter to skip)", envProxy);
    proxyRl.close();
    const cleared = proxyInput.trim().toLowerCase() === "none";
    PROXY = cleared ? null : parseProxyUrl(proxyInput);
    saveConfig({ proxyUrl: (cleared || !proxyInput.trim()) ? null : proxyInput.trim() });
    if (PROXY)         console.log(g(`\n  ✓ Proxy: ${PROXY.host}:${PROXY.port} (SOCKS${PROXY.type})\n`));
    else if (cleared)  console.log(y("  Proxy cleared.\n"));
    else               console.log(dim("  No proxy — direct connection.\n"));
  }

  // Mode selector
  console.log(b("  ── Mode ──────────────────────────────────────────────────────"));
  console.log(`  ${c("1")}  Scanner only   — scan mxemails.txt → save smtp.txt`);
  console.log(`  ${c("2")}  Send only      — load smtp.txt + send to recipients`);
  console.log(`  ${c("3")}  Scan + Send    — scan then send in one run`);
  console.log(`  ${c("4")}  Start Web GUI  — launch web dashboard (http://localhost:3000)\n`);
  const modeRl     = createRl();
  const modeChoice = await ask(modeRl, "Choose mode", "3");
  modeRl.close();

  if (modeChoice === "1") {
    await runScanner(cfg);
  } else if (modeChoice === "2") {
    await runSender(null, cfg);
  } else if (modeChoice === "4") {
    await startWebServer();
  } else {
    const { smtpEntries } = await runScanner(cfg);
    if (smtpEntries && smtpEntries.length) await runSender(smtpEntries, cfg);
  }
}

main().catch(err => {
  logger.error("fatal", { error: err.message });
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
