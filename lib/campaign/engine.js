"use strict";

const crypto = require("crypto");
const path   = require("path");
const fs     = require("fs");
const logger = require("../logger");
const { buildMailOptions, randomLocalPart, interpolate } = require("../mime/builder");
const { getTransport }    = require("../delivery/transport");
const { withRetry }              = require("../delivery/retry");
const { RateLimiter }            = require("../delivery/rate-limiter");
const { scanRecipientDomains } = require("../scanner/domain-auth");
const { recordResult, loadSentEmails } = require("./state");
const { filterValid }            = require("../hygiene/validator");
const { cleanList }              = require("../hygiene/deduplicator");

function rot(arr, i) { return arr[i % arr.length]; }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }

function renameAttachments(attachments, mode, prefix, interpSubject) {
  if (mode === "none" || !attachments.length) return attachments;
  return attachments.map(att => {
    const rawName  = (att && typeof att.filename === "string" && att.filename) ? att.filename : "attachment";
    const ext      = path.extname(rawName);
    const baseName = path.basename(rawName, ext) || "attachment";
    let newName;
    if (mode === "subject") {
      const safe = String(interpSubject || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || baseName;
      newName = attachments.length > 1 ? `${safe}_${baseName}${ext}` : `${safe}${ext}`;
    } else {
      const rand = crypto.randomBytes(3).toString("hex");
      const pfx  = ((prefix || baseName).replace(/[^a-zA-Z0-9_-]/g, "") || "file");
      newName = `${pfx}-${rand}${ext}`;
    }
    return { ...att, filename: newName };
  });
}

function extractEmails(raw) {
  const seen = new Set(), out = [];
  for (const m of raw.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)) {
    const e = m[0].toLowerCase();
    if (!seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}

/**
 * Shared campaign engine — used by both CLI and Web GUI.
 *
 * params {
 *   smtpEntries:      [{ host, fromEmail, fromemail }]  SMTP senders
 *   fromNames:        string[]
 *   subjects:         string[]
 *   htmlBodies:       string[]
 *   attachments:      [{ filename, path }]
 *   allEmails:        string[]  (raw recipient list, will be cleaned)
 *   config:           full app config object
 *   campaignId:       string  (for SQLite state grouping)
 *   csvStream:        WriteStream | null  (for CSV dual-write)
 *   cancelToken:      { cancelled: boolean, paused: boolean }
 *   onProgress:       (stats) => void
 *   onLog:            (text, logClass) => void
 * }
 *
 * Returns final stats object.
 */
async function runCampaign(params) {
  const {
    smtpEntries,
    fromNames    = [""],
    subjects     = ["(no subject)"],
    htmlBodies   = ["<p>Hello</p>"],
    attachments  = [],
    allEmails:   rawEmails = [],
    config       = {},
    campaignId   = "default",
    csvStream    = null,
    cancelToken  = { cancelled: false, paused: false },
    onProgress   = () => {},
    onLog        = () => {},
    domainPool   = [], // rotating send domains — if set, overrides fromEmail domain per-send
  } = params;

  const SEND_DELAY    = (Number.isFinite(config.sendDelay) && config.sendDelay >= 0) ? config.sendDelay : 1200;
  const GREYLIST_WAIT = (Number.isFinite(config.greylistWait) && config.greylistWait >= 0) ? config.greylistWait : 60_000;
  const CONCURRENCY   = Math.min(Number.isFinite(config.concurrency) && config.concurrency >= 1 ? config.concurrency : 2, 5);
  const HELO_HOST     = config.heloHost || "mail.localhost";
  const RESULTS_FILE  = config.resultsFile || "results.csv";
  const TLS_REJECT    = config.tlsRejectUnauthorized !== false; // default true
  const PROXY         = config._proxy || null;
  const SENDING_IP    = (config.sendingIp && config.sendingIp !== "auto") ? config.sendingIp : null;
  const ROT_EVERY     = Math.max(1, config.rotEvery ?? 2);
  const deliver       = getTransport(config);

  // Guard empty arrays — rot([], i) produces undefined subjects/bodies silently
  if (!subjects.length)   throw new Error("subjects list is empty — add at least one subject line");
  if (!htmlBodies.length) throw new Error("htmlBodies list is empty — select at least one HTML template");

  const rateLimiter = new RateLimiter(config.rateLimits || {});

  // ── Hygiene ────────────────────────────────────────────────────────────────
  onLog("Cleaning recipient list…", "system");
  const { valid: validEmails, invalid } = filterValid(rawEmails);
  if (invalid.length) onLog(`Dropped ${invalid.length} invalid address(es).`, "warn");

  const { emails: cleanedEmails, stats: hygieneStats } = cleanList(validEmails, config.suppressionFile);
  onLog(
    `List: ${hygieneStats.original} original → ${hygieneStats.final} after dedup (${hygieneStats.duplicates} dups, ${hygieneStats.suppressed} suppressed)`,
    "system"
  );

  // ── Resume ─────────────────────────────────────────────────────────────────
  const alreadySent = loadSentEmails(campaignId, RESULTS_FILE);
  const toScan      = cleanedEmails.filter(e => !alreadySent.has(e));
  if (!toScan.length) {
    onLog("All recipients already sent. Nothing to do.", "warn");
    return { sent: 0, failed: 0, dropped: 0, greylisted: 0, alreadySent: alreadySent.size };
  }

  if (alreadySent.size) onLog(`Resuming: skipping ${alreadySent.size} already-sent.`, "system");

  // ── MX + Port 25 scan (progressive) ──────────────────────────────────────
  // Relay mode skips all scanning — the relay handles MX routing itself.
  // In direct mode: well-known provider domains are pre-approved instantly
  // (no TCP probe), then unknown domains are scanned with a lightweight prober
  // (MX + port25 only, 3 s timeout, concurrency 100).
  // Send workers start as soon as the first domains are confirmed reachable —
  // scan and send run concurrently so throughput begins immediately on large lists.
  const reachable = [], dropped = [];

  const KNOWN_MX = {
    "gmail.com":      "gmail-smtp-in.l.google.com",
    "googlemail.com": "gmail-smtp-in.l.google.com",
    "yahoo.com":      "mta5.am0.yahoodns.net",
    "yahoo.co.uk":    "mta5.am0.yahoodns.net",
    "yahoo.co.in":    "mta5.am0.yahoodns.net",
    "yahoo.fr":       "mta5.am0.yahoodns.net",
    "ymail.com":      "mta5.am0.yahoodns.net",
    "hotmail.com":    "hotmail-com.olc.protection.outlook.com",
    "hotmail.co.uk":  "hotmail-com.olc.protection.outlook.com",
    "hotmail.fr":     "hotmail-com.olc.protection.outlook.com",
    "live.com":       "hotmail-com.olc.protection.outlook.com",
    "live.co.uk":     "hotmail-com.olc.protection.outlook.com",
    "outlook.com":    "outlook-com.olc.protection.outlook.com",
    "msn.com":        "hotmail-com.olc.protection.outlook.com",
    "icloud.com":     "mx1.mail.icloud.com",
    "me.com":         "mx1.mail.icloud.com",
    "mac.com":        "mx1.mail.icloud.com",
    "aol.com":        "mx-aol.mail.gm0.yahoodns.net",
    "protonmail.com": "mail.protonmail.ch",
    "proton.me":      "mail.protonmail.ch",
    "zoho.com":       "mx.zoho.com",
    "gmx.com":        "mx00.gmx.com",
    "gmx.net":        "mx00.gmx.net",
    "web.de":         "mx01.web.de",
    "mail.com":       "mx00.mail.com",
  };

  const isRelay  = config.transport === "relay";
  const skipScan = isRelay || config.skipPreScan === true;
  let scanPhaseComplete = skipScan;

  // ── Open CSV early — dropped items are recorded during background scan ─────
  let ownCsv = false;
  let csv    = csvStream;
  if (!csv) {
    const fileIsEmpty = !fs.existsSync(RESULTS_FILE) || fs.statSync(RESULTS_FILE).size === 0;
    const needsHeader = !alreadySent.size || fileIsEmpty;
    csv    = fs.createWriteStream(RESULTS_FILE, { flags: needsHeader ? "w" : "a" });
    ownCsv = true;
    if (needsHeader) csv.write("email,from_email,subject,smtp_label,status,error,tls\n");
  }

  if (skipScan) {
    for (const email of toScan)
      reachable.push({ email, mxHost: isRelay ? "relay" : email.split("@")[1], domain: email.split("@")[1] });
    onLog(`${isRelay ? "Relay mode" : "Pre-scan skipped"}: queued ${reachable.length} recipient(s).`, "system");
  } else {
    // Build domain → email list for O(1) dispatch in scan callbacks
    const emailsByDomain = {};
    for (const email of toScan) {
      const d = email.split("@")[1];
      (emailsByDomain[d] = emailsByDomain[d] || []).push(email);
    }
    const uniqueDomains  = Object.keys(emailsByDomain);
    const knownDomains   = uniqueDomains.filter(d => KNOWN_MX[d]);
    const unknownDomains = uniqueDomains.filter(d => !KNOWN_MX[d]);
    const knownSkipped   = knownDomains.length;

    // Pre-approve well-known domains — add to reachable immediately, no probe needed
    for (const d of knownDomains)
      for (const email of emailsByDomain[d])
        reachable.push({ email, mxHost: KNOWN_MX[d], domain: d });

    const logParts = [
      knownSkipped        ? `${knownSkipped} pre-approved`              : null,
      unknownDomains.length ? `scanning ${unknownDomains.length} others` : null,
    ].filter(Boolean);
    onLog(`Recipient domains: ${logParts.join(", ")} — sending starts immediately…`, "system");

    const SCAN_CONCURRENCY = config.scanConcurrency || 100;
    // Fire background scan; pushes results into reachable[] as each domain resolves.
    // Send workers below consume from reachable[] concurrently — no waiting for scan to finish.
    scanRecipientDomains(unknownDomains, PROXY, SCAN_CONCURRENCY, (_done, _t, info) => {
      if (info.open && info.mx) {
        for (const e of (emailsByDomain[info.domain] || []))
          reachable.push({ email: e, mxHost: info.mx, domain: info.domain });
      } else {
        for (const e of (emailsByDomain[info.domain] || [])) {
          dropped.push(e);
          recordResult({ campaignId, email: e, fromEmail: "", subject: "", smtpLabel: "", status: "skipped", error: "port 25 blocked", csvStream: csv });
        }
      }
      onProgress({ phase: "scan", done: _done + knownSkipped, total: uniqueDomains.length });
    }, cancelToken)
      .then(() => {
        scanPhaseComplete = true;
        if (dropped.length) onLog(`Scan complete — ${dropped.length} domain(s) unreachable.`, "system");
      })
      .catch(() => { scanPhaseComplete = true; });
  }

  // ── Send loop with concurrency ─────────────────────────────────────────────
  // confirmedTotal = upper bound for ETA. reachable[] acts as a live queue
  // (shift removes items), so its .length alone is no longer a valid total.
  const confirmedTotal = toScan.length;
  const stats = { sent: 0, failed: 0, dropped: 0, greylisted: 0 };
  const sendStart    = Date.now();
  let sendIdx        = 0; // items dequeued (for rotation index)
  let completedSends = 0; // items finished (for accurate speed/eta)

  onLog("Campaign started.", "system");
  logger.info("campaign_start", { campaignId, total: confirmedTotal, concurrency: CONCURRENCY });

  const sendOne = async (item, i) => {
    try {
    if (cancelToken.cancelled) return;

    while (cancelToken.paused) {
      await sleep(500);
      if (cancelToken.cancelled) return;
    }

    const smtpIdx        = Math.floor(i / ROT_EVERY) % smtpEntries.length;
    const smtp           = smtpEntries[smtpIdx];
    const baseFromEmail  = smtp.fromEmail || smtp.fromemail || "";
    // Pick a random pool domain for this send (null when no pool configured)
    const randDomain     = domainPool.length > 0
      ? domainPool[Math.floor(Math.random() * domainPool.length)]
      : null;
    // Priority: fixed override > unique-per-recipient (pool domain wins over manual) > smtp+pool > smtp base
    const fromEmail      = config.fromEmailOverride
      ? config.fromEmailOverride
      : config.dynamicFromDomain
        ? `${randomLocalPart()}@${randDomain || config.dynamicFromDomain}`
        : randDomain
          ? `${baseFromEmail.split("@")[0]}@${randDomain}`
          : baseFromEmail;
    const fromName  = config.fromNameOverride || rot(fromNames, i);
    const subject   = rot(subjects, i);
    const html      = rot(htmlBodies, i);
    const smtpLabel = `[SMTP.${smtpIdx + 1}]`;

    const templateVars = {
      email:  item.email,
      domain: item.domain,
      name:   fromName,
    };

    const interpSubject      = interpolate(subject, templateVars);
    const renamedAttachments = renameAttachments(
      attachments,
      config.attachmentRenameMode   || "none",
      config.attachmentRenamePrefix || "",
      interpSubject
    );

    // Rate limit per recipient domain
    await rateLimiter.acquire(item.domain, cancelToken);

    let mime;
    try {
      mime = buildMailOptions({ to: item.email, fromEmail, fromName, subject, html, attachments: renamedAttachments, config, templateVars, replyTo: config.replyTo || "" });
    } catch (err) {
      stats.failed++;
      completedSends++;
      onLog(`${smtpLabel} ${item.email} MIME error: ${err.message}`, "fail");
      recordResult({ campaignId, email: item.email, fromEmail, subject, smtpLabel, status: "failed", error: err.message, csvStream: csv });
      const _el  = (Date.now() - sendStart) / 1000;
      const _sp  = completedSends > 0 ? completedSends / _el : 0;
      const _rem = Math.max(0, confirmedTotal - dropped.length - completedSends);
      onProgress({ phase: "send", ...stats, reachable: confirmedTotal - dropped.length, total: confirmedTotal,
        speed: _sp, elapsed: Math.round(_el), eta: _sp > 0 ? Math.round(_rem / _sp) : 0,
        current: { recipient: item.email, smtpLabel, sender: fromEmail, subject } });
      return;
    }

    try {
      const result = await withRetry(
        () => deliver(item.email, item.mxHost, mime, fromEmail, HELO_HOST, {
          proxy: PROXY, tlsRejectUnauthorized: TLS_REJECT, sendingIp: SENDING_IP,
          relayHost:                config.relayHost || "127.0.0.1",
          relayPort:                config.relayPort || 587,
          relayUser:                config.relayUser || "",
          relayPass:                config.relayPass || "",
          relayTlsRejectUnauthorized: config.relayTlsRejectUnauthorized ?? false,
          relayFromEmail:           config.relayFromEmail || "",
        }),
        {
          maxRetries:   3,
          greylistWait: GREYLIST_WAIT,
          cancelToken,
          onRetry: (attempt, reason, waitMs) => {
            if (reason === "greylisted") stats.greylisted++;
            onLog(`${smtpLabel} ${item.email} ${reason} — retry ${attempt} in ${Math.round(waitMs/1000)}s…`, "warn");
          },
        }
      );

      stats.sent++;
      onLog(`✓ ${smtpLabel} ${item.email} sent (${result.tls ? "TLS" : "plain"})`, "sent");
      recordResult({ campaignId, email: item.email, fromEmail, subject, smtpLabel, status: "sent", tls: result.tls, csvStream: csv });

    } catch (err) {
      if (err.message === "Cancelled") { completedSends++; return; } // stop cleanly — not a failure
      stats.failed++;
      const short = err.message.replace(/\n.*/s, "").slice(0, 80);
      onLog(`✗ ${smtpLabel} ${item.email} ${short}`, "fail");
      recordResult({ campaignId, email: item.email, fromEmail, subject, smtpLabel, status: "failed", error: err.message, csvStream: csv });
    }

    completedSends++;
    const elapsed = (Date.now() - sendStart) / 1000;
    const speed   = completedSends > 0 ? completedSends / elapsed : 0;
    const rem     = Math.max(0, confirmedTotal - dropped.length - completedSends);
    const eta     = speed > 0 ? Math.round(rem / speed) : 0;
    onProgress({
      phase: "send",
      ...stats,
      reachable: confirmedTotal - dropped.length,
      total:     confirmedTotal,
      speed,
      elapsed:   Math.round(elapsed),
      eta,
      current:   { recipient: item.email, smtpLabel, sender: fromEmail, subject },
    });
    } catch (err) {
      if (err.message === "Cancelled") { completedSends++; return; }
      throw err;
    }
  };

  // Workers run concurrently with the background scan.
  // When reachable is empty but scan is still in progress, workers wait 100 ms
  // for the next batch of confirmed domains rather than exiting early.
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (!cancelToken.cancelled) {
      const item = reachable.shift();
      if (!item) {
        if (scanPhaseComplete) break;
        await sleep(100);
        continue;
      }
      const i = sendIdx++;
      try {
        await sendOne(item, i);
      } catch (err) {
        stats.failed++;
        completedSends++;
        onLog(`Worker error for ${item?.email}: ${err.message}`, "fail");
      }
      if (!cancelToken.cancelled) await sleep(SEND_DELAY);
    }
  });

  await Promise.all(workers);

  if (ownCsv) await new Promise(r => csv.end(r));

  stats.dropped = dropped.length;
  const totalSent = stats.sent + alreadySent.size;
  onLog(`Campaign done. Sent: ${totalSent} (${alreadySent.size} resumed), Failed: ${stats.failed}, Dropped: ${stats.dropped}`, "system");
  logger.info("campaign_done", { campaignId, ...stats, alreadySent: alreadySent.size });

  return { ...stats, alreadySent: alreadySent.size };
}

module.exports = { runCampaign, extractEmails };
