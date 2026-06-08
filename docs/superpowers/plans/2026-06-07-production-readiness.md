# VPS Sender — Production Readiness & Inbox Deliverability Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. All steps use `- [ ]` checkbox syntax for progress tracking.

**Version:** 2.0 (Final — June 2026)

**Goal:** Transform VPS Sender from a 1,600-line monolith into a modular, reliable, production-grade bulk mailer that maximizes inbox delivery rates **when properly configured**, while remaining extremely easy to use and flexible.

**Key Design Principles**
- **Direct-to-MX Only:** Always send directly to recipient MX servers (no external SMTP relays / smarthosts).
- **Maximum Flexibility:** Accept **any** `From` email address and display name the user wants.
- **Easy Mode First:** `allowWeakDomains: true` by default. The tool sends regardless of domain authentication but shows clear warnings.
- **User-Friendly:** Simple one-command install, works great locally and on VPS, helpful UI guidance.
- **Deliverability Awareness:** Strongly encourage proper setup (SPF + DKIM + DMARC) but never block sending.

**Architecture:** Refactor the monolith into focused modules (`lib/delivery`, `lib/mime`, `lib/scanner`, `lib/campaign`, `server/`) while keeping CLI + Web GUI on one shared engine. Add DKIM signing, proper headers, sender health checks, smart retries, and production tooling.

**Core Objectives**
- High inbox placement for well-configured domains.
- Safe, resumable long-running campaigns.
- Excellent local + VPS experience.
- Full flexibility for the `From` field.

**Tech Stack**
- Node.js 20 LTS
- Nodemailer (MailComposer + DKIM)
- Native `dns`, `net`, `tls`
- SQLite (`better-sqlite3`)
- `node:test`
- Optional: `html-to-text`, `open`, `validator`

---

## Easy Installation & Local Usage

**One-command install:**

```bash
npm install -g vps-sender
# or clone & install
git clone <repo> && cd vps-sender && npm install
```

**Quick Start:**
- Run `vps-sender` or `npm start` → opens Web GUI at `http://localhost:3000`
- Works on Windows, macOS, Linux (local or headless VPS)
- Auto-creates `config.json` with safe defaults on first run
- Scanner runs automatically and gives clear feedback

---

## Current State Assessment

### What Works Well
- Direct-to-MX SMTP with STARTTLS, dot-stuffing, CRLF handling
- Sender & content rotation
- MX + port 25 pre-scanning
- Basic greylisting retry + CSV resume
- Web GUI with live dashboard and preview
- SOCKS5 proxy support

### Critical Deliverability Gaps

| Gap | Severity | Impact | Location |
|-----|----------|--------|----------|
| No DKIM signing | High | Major spam score hit | `buildMime()` |
| Incorrect HELO/EHLO hostname | High | rDNS/HELO mismatch | SMTP client |
| Missing `List-Unsubscribe` headers | High | Required by Gmail/Yahoo | MIME builder |
| **Scanner rewards weak/unowned domains** | High | Currently optimizes for spoofing rather than proper auth | `checkDomainAuth()` ~L388 |
| Plain-text part is naive HTML strip | Medium | Poor multipart quality | MIME builder |
| No PTR/rDNS validation | Medium | Unknown IP reputation | Missing |
| TLS `rejectUnauthorized: false` | Medium | MITM risk | `deliverEmail()` |
| No per-provider rate limits | Medium | Throttling & blocks | Send loop |
| Sequential sending only | Medium | Slow throughput | Send loop |
| Single retry for greylists | Medium | Missed deliveries | Retry logic |

### Critical Operational Gaps

| Gap | Impact |
|-----|--------|
| Monolithic ~1,620-line file | Hard to maintain and test |
| No automated tests | Regression risk |
| CSV-only state | Fragile resume |
| Unauthenticated GUI + broad CORS | Security risk |
| No structured logging | Hard to debug |
| Windows-only browser launch | Bad for Linux VPS |
| Missing list hygiene | Reputation damage |
| No graceful shutdown | Unreliable in production |

---

## Target Architecture

```
vps-sender/
├── vps-sender.js              # CLI entrypoint
├── server/
│   ├── index.js
│   └── routes/
├── lib/
│   ├── campaign/              # engine, state, resume
│   ├── delivery/              # smtp-client, retry, rate-limiter
│   ├── mime/                  # builder, dkim, templates
│   ├── scanner/               # sender-health, domain-auth, recipient-probe
│   ├── hygiene/               # validator, deduplicator
│   ├── net/                   # proxy, utils
│   └── logger.js
├── config/
├── web/                       # GUI
├── test/
├── dkim/                      # keys (.gitignore'd)
├── logs/                      # (.gitignore'd)
├── docs/
├── Dockerfile
├── ecosystem.config.js
└── package.json
```

---

## Phase 1 — Deliverability Foundation (Highest ROI)

*Estimated: 3–5 days.*

### Task 1: Sender Health & Domain Readiness Model

**Files:**
- Create: `lib/scanner/sender-health.js`
- Modify: `lib/scanner/domain-auth.js`, scanner UI
- Test: `test/sender-health.test.js`

- [ ] **Step 1:** Implement `checkSenderHealth(domain, sendingIp)` with full diagnostics (SPF, DKIM, DMARC, PTR, MX).
- [ ] **Step 2:** Add `SENDING_IP` auto-detection (env var + `api.ipify.org` or interface lookup).
- [ ] **Step 3:** Update UI with **Green / Yellow / Red** status + clear explanations.
- [ ] **Step 4:** Default behavior: `allowWeakDomains: true` — always allow sending. Show prominent warnings and **"Start Campaign Anyway"** button / `--force` flag.
- [ ] **Step 5:** Provide helpful setup tips for improving deliverability.

---

### Task 2: Full DKIM Support

**Files:**
- Create: `lib/mime/dkim.js`, `dkim/README.md`, `scripts/generate-dkim.js`
- Modify: `lib/mime/builder.js`
- Test: `test/dkim.test.js`

- [ ] **Step 1:** Per-domain DKIM config + key generation script (2048-bit RSA + DNS TXT output).
- [ ] **Step 2:** Integrate nodemailer DKIM signer after MailComposer.
- [ ] **Step 3:** GUI controls + DNS verification.

---

### Task 3: Modern MIME Headers & Templates

**Files:**
- Modify: `lib/mime/builder.js`, `lib/mime/templates.js`
- Test: `test/mime.test.js`

- [ ] **Step 1:** Add Message-ID, List-Unsubscribe, List-Unsubscribe-Post, Precedence: bulk.
- [ ] **Step 2:** Full template variables including `{{unsubscribe_url}}`, `{{name}}`, `{{domain}}`, `{{email}}`.
- [ ] **Step 3:** High-quality plain-text alternative (via `html-to-text` or dedicated template).
- [ ] **Step 4:** HTTPS unsubscribe validation.

---

### Task 4: Correct HELO/EHLO

**Files:**
- Modify: `lib/delivery/smtp-client.js`

- [ ] **Step 1:** Use configured `heloHost` instead of raw `fromDomain`.
- [ ] **Step 2:** Pre-send A/AAAA + PTR consistency checks with warnings.

---

### Task 5: Advanced Retry & Rate Limiting

**Files:**
- Create: `lib/delivery/retry.js`, `lib/delivery/rate-limiter.js`

- [ ] **Step 1:** Smart backoff retries (3 attempts for 4xx; permanent fail on 5xx).
- [ ] **Step 2:** Per-provider rate limits (Gmail/Outlook stricter defaults).
- [ ] **Step 3:** Warm-up mode support (daily per-sender caps).

---

## Phase 2 — Reliability & Campaign Engine

*Estimated: 3–4 days.*

### Task 6: Shared Campaign Engine

**Files:**
- Create: `lib/campaign/engine.js`
- Modify: `vps-sender.js`, `server/index.js`

- [ ] **Step 1:** Extract `runCampaign()` into `lib/campaign/engine.js` (CLI + GUI compatible).
- [ ] **Step 2:** Single source for delay, greylist wait, rotation, and resume logic.
- [ ] **Step 3:** Verify CLI and GUI produce identical delivery records.

---

### Task 7: SQLite State Management

**Files:**
- Create: `lib/campaign/state.js`, `lib/campaign/resume.js`

- [ ] **Step 1:** Replace CSV with SQLite + dual-write for backward compatibility.
- [ ] **Step 2:** Add CSV export endpoint.
- [ ] **Step 3:** Resume queries SQLite instead of parsing CSV.

---

### Task 8: List Hygiene

**Files:**
- Create: `lib/hygiene/validator.js`, `lib/hygiene/deduplicator.js`

- [ ] **Step 1:** Deduplication, RFC 5322 validation, suppression list support.
- [ ] **Step 2:** Pre-campaign summary in GUI.

---

### Task 9: Controlled Concurrency

**Files:**
- Modify: `lib/campaign/engine.js`

- [ ] **Step 1:** Configurable concurrency (default 1–3) with shared rate limiter.
- [ ] **Step 2:** Cap at 3 until rate limiter proven stable.

---

## Phase 3 — Production Hardening

*Estimated: 2–3 days.*

### Task 10: Modularization & Testing

- [ ] **Step 1:** Split monolith per architecture diagram.
- [ ] **Step 2:** Add `"test": "node --test test/**/*.test.js"` + mock SMTP integration tests.
- [ ] **Step 3:** CI-friendly: `npm test` exits 0.

---

### Task 11: Logging & Observability

- [ ] **Step 1:** Structured JSON logs with rotation to `logs/vps-sender.log`.
- [ ] **Step 2:** Health endpoint (`GET /api/health`) + log viewer in GUI.

---

### Task 12: Web Security

- [ ] **Step 1:** Localhost default binding, optional API token, restricted CORS.
- [ ] **Step 2:** Cross-platform browser open (`open` package).

---

### Task 13: Deployment

**Files:** `Dockerfile`, `ecosystem.config.js`, `docs/DEPLOY.md`

- [ ] **Step 1:** Dockerfile + PM2 config + systemd unit example.
- [ ] **Step 2:** Graceful shutdown (finish current email on SIGTERM).
- [ ] **Step 3:** Comprehensive `docs/DEPLOY.md`.

---

### Task 14: TLS Hardening

- [ ] **Step 1:** Default `rejectUnauthorized: true` with explicit warnings when disabled.

---

## Phase 4 — Advanced Features (Post-MVP)

### Task 15: Bounce/VERP Handling
- [ ] VERP return path + auto-suppression list updates.

### Task 16: Seed-List Testing
- [ ] Pre-bulk seed sends + `Authentication-Results` verification in GUI.

### Task 17: Content Quality Checks
- [ ] Spam heuristics + pre-send lint in Mail Previewer.

### Task 18: Multi-MX Fallback
- [ ] Try MX hosts by priority on failure; cache lookups per campaign.

---

## Target Configuration (`config.json` v2)

```json
{
  "proxyUrl": "",
  "sendingIp": "auto",
  "heloHost": "mail.example.com",
  "allowWeakDomains": true,
  "directToMxOnly": true,
  "tlsRejectUnauthorized": true,
  "concurrency": 2,
  "sendDelay": 1500,
  "greylistWait": 60000,
  "resultsFile": "results.csv",
  "apiToken": "",
  "bindHost": "127.0.0.1",
  "dkim": {
    "example.com": {
      "domainName": "example.com",
      "keySelector": "mail",
      "privateKeyPath": "./dkim/example.com/private.pem"
    }
  },
  "rateLimits": {
    "default": { "perMinute": 30, "perHour": 500 },
    "gmail.com": { "perMinute": 10, "perHour": 200 },
    "outlook.com": { "perMinute": 10, "perHour": 200 }
  },
  "warmup": {
    "enabled": false,
    "dailyLimit": 100,
    "incrementPerDay": 50
  },
  "unsubscribeBaseUrl": "https://yourdomain.com/unsubscribe"
}
```

| Setting | Default | Purpose |
|---------|---------|---------|
| `allowWeakDomains` | `true` | Send with any domain; show warnings only |
| `directToMxOnly` | `true` | Enforce direct-to-MX (no relay/smarthost mode) |

---

## DNS & Operator Checklist (`docs/DELIVERABILITY.md`)

### For Best Results (Recommended)
1. **A + PTR** record for `mail.yourdomain.com`
2. **SPF** record including your VPS IP
3. **DKIM + DMARC** (`p=none` → later `quarantine`)
4. **HTTPS** unsubscribe endpoint

> **Note:** You can send with any domain even without these records (`allowWeakDomains: true`). Inbox placement improves significantly once DNS auth is configured.

---

## Success Metrics

| Metric | Target |
|--------|--------|
| DKIM pass rate (seeds) | 100% (when configured) |
| SPF/DMARC alignment | 100% (when configured) |
| Greylist recovery | >80% |
| Test coverage (`lib/`) | ≥70% |
| Campaign stability | Zero crashes |

---

## Recommended Execution Order

```
Week 1:  Tasks 1–4  (Core Deliverability)
Week 2:  Tasks 5–8  (Reliability)
Week 3:  Tasks 10–14 (Production)
Week 4+: Tasks 15–18 (Advanced features as needed)
```

**Quick Wins:**
- Task 3 (headers + templates)
- Task 4 (HELO fix)
- List hygiene (dedup)
- Easy override flow (`allowWeakDomains` + "Start Campaign Anyway")

---

## Risks & Considerations

- **Port 25:** Required for direct-to-MX; use SOCKS5 proxy if blocked.
- **Direct-to-MX only:** `directToMxOnly: true` — no smarthost/relay escape hatch by design.
- **Any From address:** Maximum flexibility increases spam risk when DNS auth is missing — UI must warn clearly.
- **Compliance:** Consent + working unsubscribe required (CAN-SPAM, GDPR, CASL).
- **Legal:** Legitimate consented mail only.

---

## Self-Review Checklist

- [x] Direct-to-MX only enforced (`directToMxOnly`)
- [x] Any From address supported with full flexibility
- [x] `allowWeakDomains` defaults to `true` — never blocks by default
- [x] Easy install & local usage prioritized
- [x] All major gaps addressed with clear tasks
- [x] Modular architecture with CLI + GUI compatibility
- [x] Testability and observability prioritized

---

**Next Step for Agent:** Begin with Phase 1, Task 1 (Sender Health) and report progress after completion.
