"use strict";

const fs     = require("fs");
const logger = require("../logger");
const { buildMailOptions, randomLocalPart } = require("../mime/builder");
const { getTransport }    = require("../delivery/transport");
const { withRetry }              = require("../delivery/retry");
const { RateLimiter }            = require("../delivery/rate-limiter");
const { probePort25, scanDomains } = require("../scanner/domain-auth");
const { recordResult, loadSentEmails } = require("./state");
const { filterValid }            = require("../hygiene/validator");
const { cleanList }              = require("../hygiene/deduplicator");

function rot(arr, i) { return arr[i % arr.length]; }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }

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

  // ── MX + Port 25 scan (skipped in relay mode when preScanRelay is false) ────
  const reachable = [], dropped = [];

  if (config.transport !== "relay" || config.preScanRelay !== false) {
    const uniqueDomains = [...new Set(toScan.map(e => e.split("@")[1]))];
    onLog(`Scanning ${uniqueDomains.length} recipient domain(s)…`, "system");

    const probeMap = {};
    await scanDomains(uniqueDomains, PROXY, 15, (done, total, info) => {
      probeMap[info.domain] = info;
      onProgress({ phase: "scan", done, total });
    }, cancelToken);

    for (const email of toScan) {
      if (cancelToken.cancelled) break;
      const d = email.split("@")[1];
      let p = probeMap[d];
      if (!p && !cancelToken.cancelled) p = await probePort25(d, PROXY);
      if (cancelToken.cancelled) break;
      const open = p && p.mx && (p.open || p.port25Open);
      if (!open) dropped.push(email);
      else reachable.push({ email, mxHost: p.mx, domain: d });
    }

    if (cancelToken.cancelled) {
      for (const item of reachable) {
        recordResult({ campaignId, email: item.email, fromEmail: "", subject: "", smtpLabel: "", status: "skipped", error: "cancelled", csvStream });
      }
      onLog("Campaign cancelled during scan.", "warn");
      return { sent: 0, failed: 0, dropped: dropped.length, greylisted: 0, alreadySent: alreadySent.size };
    }

    onLog(`Scan: ${reachable.length} reachable, ${dropped.length} unreachable.`, "system");
  } else {
    for (const email of toScan) {
      reachable.push({ email, mxHost: "relay", domain: email.split("@")[1] });
    }
    onLog(`Relay mode: skipping recipient pre-scan (${reachable.length} queued).`, "system");
  }

  // Write skipped entries
  for (const e of dropped) {
    recordResult({ campaignId, email: e, fromEmail: "", subject: "", smtpLabel: "", status: "skipped", error: "port 25 blocked", csvStream });
  }

  if (!reachable.length) {
    onLog("No reachable recipients.", "warn");
    return { sent: 0, failed: 0, dropped: dropped.length, greylisted: 0, alreadySent: alreadySent.size };
  }

  // ── Open CSV if not provided ───────────────────────────────────────────────
  let ownCsv = false;
  let csv    = csvStream;
  if (!csv) {
    // Write header whenever the file is absent/empty, even in resume mode (file may have been deleted)
    const fileIsEmpty = !fs.existsSync(RESULTS_FILE) || fs.statSync(RESULTS_FILE).size === 0;
    const needsHeader = !alreadySent.size || fileIsEmpty;
    const mode = needsHeader ? "w" : "a";
    csv    = fs.createWriteStream(RESULTS_FILE, { flags: mode });
    ownCsv = true;
    if (needsHeader) csv.write("email,from_email,subject,smtp_label,status,error,tls\n");
  }

  // ── Send loop with concurrency ─────────────────────────────────────────────
  // stats.sent starts at 0 for new sends; alreadySent.size is added back in
  // the final broadcast so the progress bar denominator stays consistent.
  const stats = { sent: 0, failed: 0, dropped: dropped.length, greylisted: 0 };
  const sendStart = Date.now();
  let sendIdx        = 0; // items dequeued (for rotation index)
  let completedSends = 0; // items finished (for accurate speed/eta)

  onLog("Campaign started.", "system");
  logger.info("campaign_start", { campaignId, total: reachable.length, concurrency: CONCURRENCY });

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
    // From address priority: unique-per-recipient > fixed override > domain rotation > smtp entry
    const fromEmail      = config.dynamicFromDomain
      ? `${randomLocalPart()}@${config.dynamicFromDomain}`
      : config.fromEmailOverride
        ? config.fromEmailOverride
        : domainPool.length > 0
          ? `${baseFromEmail.split("@")[0]}@${domainPool[Math.floor(Math.random() * domainPool.length)]}`
          : baseFromEmail;
    const fromName  = rot(fromNames, i);
    const subject   = rot(subjects, i);
    const html      = rot(htmlBodies, i);
    const smtpLabel = `[SMTP.${smtpIdx + 1}]`;

    const templateVars = {
      email:  item.email,
      domain: item.domain,
      name:   fromName,
    };

    // Rate limit per recipient domain
    await rateLimiter.acquire(item.domain, cancelToken);

    let mime;
    try {
      mime = buildMailOptions({ to: item.email, fromEmail, fromName, subject, html, attachments, config, templateVars });
    } catch (err) {
      stats.failed++;
      completedSends++;
      onLog(`${smtpLabel} ${item.email} MIME error: ${err.message}`, "fail");
      recordResult({ campaignId, email: item.email, fromEmail, subject, smtpLabel, status: "failed", error: err.message, csvStream: csv });
      const _el = (Date.now() - sendStart) / 1000;
      const _sp = completedSends > 0 ? completedSends / _el : 0;
      onProgress({ phase: "send", ...stats, reachable: reachable.length, total: reachable.length,
        speed: _sp, elapsed: Math.round(_el), eta: _sp > 0 ? Math.round((reachable.length - completedSends) / _sp) : 0,
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
    const eta     = speed > 0 ? Math.round((reachable.length - completedSends) / speed) : 0;
    onProgress({
      phase: "send",
      ...stats,
      reachable: reachable.length,
      total:     reachable.length,
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

  // Controlled concurrency via semaphore
  const queue = [...reachable];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && !cancelToken.cancelled) {
      const item = queue.shift();
      if (!item) break;
      const i = sendIdx++;
      try {
        await sendOne(item, i);
      } catch (err) {
        // sendOne re-throws non-Cancelled errors; catch here so one worker
        // failure doesn't silently terminate the goroutine.
        stats.failed++;
        completedSends++;
        onLog(`Worker error for ${item?.email}: ${err.message}`, "fail");
      }
      if (i < reachable.length - 1 && !cancelToken.cancelled) {
        await sleep(SEND_DELAY);
      }
    }
  });

  await Promise.all(workers);

  if (ownCsv) await new Promise(r => csv.end(r));

  const totalSent = stats.sent + alreadySent.size;
  onLog(`Campaign done. Sent: ${totalSent} (${alreadySent.size} resumed), Failed: ${stats.failed}, Dropped: ${stats.dropped}`, "system");
  logger.info("campaign_done", { campaignId, ...stats, alreadySent: alreadySent.size });

  return { ...stats, alreadySent: alreadySent.size };
}

module.exports = { runCampaign, extractEmails };
