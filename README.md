# VPS Sender v2 — Multi-Transport Email Sender

Send email with full deliverability control: **direct-to-MX** (no third-party relay), **local MTA relay** (Postfix / hMailServer), DKIM signing, split-header FROM, smart retries, rate limiting, SQLite state, and a live Web GUI manageable entirely from a browser.

---

## Table of Contents

1. [Requirements](#requirements)
2. [Installation](#installation)
3. [Quick Start](#quick-start)
4. [Transport Modes](#transport-modes)
5. [Web GUI](#web-gui)
6. [Configuration Reference](#configuration-reference)
7. [DKIM Setup](#dkim-setup)
8. [Local MTA Relay Setup](#local-mta-relay-setup)
9. [Split-Header Signing](#split-header-signing)
10. [Template Variables](#template-variables)
11. [Workspace File Reference](#workspace-file-reference)
12. [CLI Mode](#cli-mode)
13. [Public Access & Remote Server](#public-access--remote-server)
14. [VPS Deployment](#vps-deployment)
15. [SOCKS5 Proxy](#socks5-proxy)
16. [Monitoring & Logging](#monitoring--logging)
17. [Environment Variables](#environment-variables)
18. [Deliverability Checklist](#deliverability-checklist)
19. [Results & Resume](#results--resume)
20. [Troubleshooting](#troubleshooting)

---

## Requirements

| | |
|---|---|
| **Node.js** | v18 or newer — **the install scripts install it for you** |
| **OS** | Windows 10/11, Ubuntu/Debian, Fedora/RHEL/CentOS, macOS |
| **Network** | Outbound **port 25** open (for direct mode) **or** a local MTA (for relay mode) |

> **Port 25 blocked?** Most ISPs and cloud providers (AWS, GCP, Azure, DigitalOcean) block outbound port 25 by default. Solutions:
> - Use a VPS that allows SMTP: **Hetzner, OVH, Contabo, Vultr, Hostinger**
> - Request port 25 unblock from your provider
> - Configure a SOCKS5 proxy in Settings
> - Switch to **relay mode** with a local MTA (Postfix / hMailServer) — the MTA handles port 25 from its IP

---

## Installation

### Windows

Double-click **`install.bat`** or right-click → **Run as administrator**.

```
install.bat
```

| Step | What happens |
|------|-------------|
| 1 | Checks for Node.js; auto-installs v20 LTS via **winget** if missing |
| 2 | Checks for Visual Studio Build Tools; installs via winget if missing |
| 3 | Runs `npm install`; retries with build tools if the first attempt fails |
| 4 | Creates `logs\` and `dkim\` directories |
| 5 | Creates `mxemails.txt`, `recipients.txt`, `subjects.txt`, `names.txt`, `body.html` if absent |
| 6 | Tests outbound port 25 and reports status |
| 7–8 | Checks firewall; adds Windows Firewall rule for port 3000 |
| 9 | Prompts to bind GUI to `0.0.0.0` (public) and set an API token |
| 10 | Optionally installs PM2 and starts the server as a background process |
| 11 | **hMailServer relay guidance** — shows setup steps and auto-updates `config.json` if you choose relay mode |

**If winget isn't available** (older Windows):
1. Download and install Node.js 20 LTS from [nodejs.org](https://nodejs.org/en/download)
2. Re-run `install.bat`

---

### Linux / Ubuntu / Debian (including fresh VPS)

Works as root (typical fresh VPS) or as a normal user with `sudo`:

```bash
bash install.sh
```

> No need to `chmod` first — just run it with `bash`.

| Step | What happens |
|------|-------------|
| 1 | Installs `curl` if missing |
| 2 | Adds NodeSource repo and installs Node.js 20 LTS if missing/outdated |
| 3 | Installs `build-essential` + `python3` |
| 4 | Runs `npm install` |
| 5 | Creates `logs/` and `dkim/` directories |
| 6 | Creates all 5 starter files if absent |
| 7 | Tests outbound port 25 via `nc` / `/dev/tcp` / `curl` |
| 8 | Opens port 3000 in UFW (Ubuntu/Debian) or firewalld (Fedora/RHEL) |
| 9 | Prompts to bind GUI to `0.0.0.0` and set an API token |
| 10 | Optionally installs PM2, starts the server, configures auto-start on reboot |
| 11 | **Postfix relay setup** — installs and configures Postfix as a loopback-only relay if you choose relay mode |

**Supported package managers:** `apt` (Ubuntu/Debian), `dnf` (Fedora/RHEL), `yum` (CentOS)

**Fresh Ubuntu VPS:**
```bash
cd vps-sender
bash install.sh
```

---

### macOS

```bash
bash install.sh
```

- Installs Node.js via Homebrew (`brew install node@20`)
- Prompts to install Xcode Command Line Tools if build tools are missing
- Step 11 shows a note to install Postfix manually or use an external SMTP relay

---

### Manual (any platform)

```bash
# 1. Install Node.js 18+ from https://nodejs.org

# 2. Install build tools
#    Ubuntu/Debian:  sudo apt install build-essential python3
#    Fedora/RHEL:    sudo dnf install gcc-c++ make python3
#    macOS:          xcode-select --install

# 3. Install dependencies
npm install

# 4. Create runtime directories
mkdir -p logs dkim
```

---

## Quick Start

### 1. Launch the Web GUI

```bash
npm start
```

Opens **http://localhost:3000** automatically.

### 2. Prepare your files via the browser

Use the **Workspace Files** tab to upload, edit, paste, or create:

| File | What goes in it |
|------|----------------|
| `mxemails.txt` | Your sender email addresses (one per line) |
| `recipients.txt` | Destination addresses to send to |
| `subjects.txt` | Email subjects, one per line (rotates) |
| `names.txt` | Sender display names, one per line (rotates) |
| `body.html` | Your HTML email body |

Upload PDF/image/ZIP attachments from the **Attachment Files** panel below the editor.

### 3. Or use the interactive CLI

```bash
npm run cli
```

---

## Transport Modes

VPS Sender supports three modes. Switch between them in **Settings → Transport Mode**.

### Direct to MX (default)

```json
{ "transport": "direct" }
```

The app resolves each recipient's MX record and connects directly on port 25. No third-party relay. The Domain Scanner tab checks sender domains for MX, SPF, DMARC, and port 25 reachability before a campaign starts.

**Best for:** VPS with open port 25, full deliverability control.

### Local MTA Relay

```json
{
  "transport":   "relay",
  "relayHost":   "127.0.0.1",
  "relayPort":   25,
  "relayUser":   "",
  "relayPass":   "",
  "envelopeDomain": "yourdomain.com",
  "preScanRelay": false
}
```

The app submits mail to a local MTA (Postfix on Linux/Mac, hMailServer on Windows) which handles outbound delivery and queuing. The MX scan is optional (`preScanRelay: false` skips it and sends all recipients directly to the relay).

**Best for:** High-volume sending, better queue management, managed retry, servers where port 25 is available but you want MTA-level features.

> See [Local MTA Relay Setup](#local-mta-relay-setup) for full configuration steps.

---

## Web GUI

```bash
npm start
# opens http://localhost:3000
```

### Dashboard Tab

Real-time campaign control:

- **Stats** — Sent / Failed / Dropped / Greylisted counts
- **Progress bar** — Completion percentage with speed and ETA
- **Controls** — Start / Pause / Resume / Stop
- **Live log** — Color-coded stream of every delivery attempt
- **Chart** — Donut breakdown of results

### Campaign Wizard Tab

Configure before launching:

- Recipient file, names file, subjects file, HTML body file(s)
- SMTP config file (`smtp.txt`) or direct-to-MX (no smtp.txt needed)
- Optional attachments
- Rotate sender every N emails
- Resume mode (skip already-sent addresses)

### Domain Scanner Tab

Evaluate sender domains before committing to a campaign:
1. Pick your `mxemails.txt`
2. Toggle **Include WEAK domains** to send regardless of strict SPF/DMARC
3. Click **Start Scan** — results table shows MX, port 25 status, SPF, DMARC
4. Saves usable entries to `smtp.txt`

> In relay mode the scanner is still useful — it evaluates sender domains for SPF/DMARC strength so you know which ones are safe to use as the visible `From:`.

### Mail Previewer Tab

Preview your rendered email before sending — enter a test recipient, sender, and subject to see the final output with all template variables applied.

### Workspace Files Tab

Full file management directly in the browser — no SSH required:

| Action | How |
|--------|-----|
| **Edit** | Click a file → edit in the code pane → Save |
| **Create** | Click **+ New File** → enter a name |
| **Upload** | Click **↑ Upload** or drag files onto the editor panel |
| **Paste** | Open a file, click **📋 Paste** to paste clipboard content |
| **Download** | Select a file → click **↓ Download** |
| **Delete** | Select a file → click **🗑 Delete** |
| **Attachments** | Upload binary files (PDF, images, ZIP, DOCX) in the Attachments panel; download or delete there too |

Drag-and-drop works on the editor panel — drop one or more files and they upload automatically. Text files open for editing immediately.

### Settings Tab

All `config.json` fields are configurable from the browser:

| Section | Fields |
|---------|--------|
| **General** | Proxy URL, send delay, greylist retry timeout, results file, HELO hostname, concurrency, unsubscribe URL, TLS validation |
| **Server Access** | Bind address, port, custom domain, API token, public URL display |
| **Sending Options** | Sending IP, direct-to-MX only, allow weak domains |
| **Transport Mode** | Direct / Local MTA Relay toggle; relay host, port, user, password; pre-scan relay checkbox |
| **Envelope Domain** | Override the SMTP envelope FROM domain for split-header signing |
| **Send Warmup** | Enable warmup, daily limit, daily increment |
| **Rate Limits** | JSON editor for per-provider per-minute/per-hour caps |
| **DKIM Configuration** | JSON editor for DKIM key paths per domain |
| **DKIM Key Generation** | Generate a new RSA-2048 DKIM key pair for any domain — shows SPF, DKIM, and DMARC DNS records to publish, plus OS-specific MTA instructions |

---

## Configuration Reference

Auto-created on first run with safe defaults. Edit by hand, via the Settings tab, or via the install scripts.

```json
{
  "proxyUrl":              "",
  "sendingIp":             "auto",
  "heloHost":              "mail.yourdomain.com",
  "allowWeakDomains":      true,
  "directToMxOnly":        true,
  "tlsRejectUnauthorized": true,
  "concurrency":           2,
  "sendDelay":             1500,
  "greylistWait":          60000,
  "resultsFile":           "results.csv",
  "bindHost":              "127.0.0.1",
  "port":                  3000,
  "domain":                "",
  "apiToken":              "",
  "transport":             "direct",
  "relayHost":             "127.0.0.1",
  "relayPort":             587,
  "relayUser":             "",
  "relayPass":             "",
  "envelopeDomain":        "",
  "preScanRelay":          true,
  "unsubscribeBaseUrl":    "",
  "warmup": {
    "enabled":         false,
    "dailyLimit":      100,
    "incrementPerDay": 50
  },
  "rateLimits": {
    "default":      { "perMinute": 30, "perHour": 500 },
    "gmail.com":    { "perMinute": 10, "perHour": 200 },
    "outlook.com":  { "perMinute": 10, "perHour": 200 }
  },
  "dkim": {}
}
```

### General Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `proxyUrl` | `""` | SOCKS5/4 proxy. Format: `socks5://user:pass@host:port` |
| `sendingIp` | `"auto"` | Source IP for outbound SMTP. `"auto"` uses the default interface |
| `heloHost` | `"mail.localhost"` | Hostname in SMTP EHLO — should match your VPS PTR/rDNS |
| `allowWeakDomains` | `true` | Send from domains regardless of SPF/DMARC strength |
| `directToMxOnly` | `true` | Always connect directly to MX servers in direct mode |
| `tlsRejectUnauthorized` | `true` | Verify MX TLS certificates. Set `false` for self-signed certs |
| `concurrency` | `2` | Parallel SMTP connections (1–5 recommended) |
| `sendDelay` | `1500` | Milliseconds between sends |
| `greylistWait` | `60000` | Ms to wait before retrying a `4xx` greylisting response |
| `resultsFile` | `"results.csv"` | CSV log of all delivery attempts |
| `unsubscribeBaseUrl` | `""` | Base URL for `List-Unsubscribe` header and `{{unsubscribe_url}}` variable |

### Server Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `bindHost` | `"127.0.0.1"` | GUI listen address. `"0.0.0.0"` = public |
| `port` | `3000` | TCP port the web GUI listens on |
| `domain` | `""` | Custom domain for CORS and the public URL shown in Settings |
| `apiToken` | `""` | Required `X-API-Token` header. Empty = no auth |

### Transport Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `transport` | `"direct"` | `"direct"` = connect to MX servers; `"relay"` = submit to local MTA |
| `relayHost` | `"127.0.0.1"` | Relay hostname (used when `transport = "relay"`) |
| `relayPort` | `587` | Relay port. Use `25` for Postfix loopback, `587` for hMailServer submission |
| `relayUser` | `""` | Relay SMTP username (leave blank for unauthenticated loopback relay) |
| `relayPass` | `""` | Relay SMTP password |
| `envelopeDomain` | `""` | Overrides the SMTP envelope `MAIL FROM` domain for split-header signing. See [Split-Header Signing](#split-header-signing) |
| `preScanRelay` | `true` | When `true`, the MX pre-flight scan runs even in relay mode. Set `false` to skip and queue all recipients directly |
| `relayFromEmail` | `""` | Override SMTP envelope `MAIL FROM` to a specific address. Required for Mailcow and other relays that enforce authenticated user = envelope sender. See [Relay From Email](#relay-from-email-mailcow--postal-pattern) |
| `fromEmailOverride` | `""` | Fixed `From:` address for all campaign emails. Set via Campaign Wizard → From Address Mode → Fixed |

### Warmup Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `warmup.enabled` | `false` | Gradually increase daily volume to build sender reputation |
| `warmup.dailyLimit` | `100` | Max emails per day during warmup |
| `warmup.incrementPerDay` | `50` | How much to raise the daily limit each day |

### Rate Limits

Token-bucket per-provider caps. Key = recipient domain or `"default"`.

```json
{
  "rateLimits": {
    "default":      { "perMinute": 30, "perHour": 500 },
    "gmail.com":    { "perMinute": 10, "perHour": 200 },
    "outlook.com":  { "perMinute": 10, "perHour": 200 },
    "yahoo.com":    { "perMinute": 10, "perHour": 200 }
  }
}
```

### DKIM Map

Keyed by sender domain. See [DKIM Setup](#dkim-setup).

```json
{
  "dkim": {
    "yourdomain.com": {
      "domainName":      "yourdomain.com",
      "keySelector":     "mail",
      "privateKeyPath":  "dkim/yourdomain.com.pem"
    }
  }
}
```

---

## DKIM Setup

DKIM signs your outgoing mail cryptographically. Gmail and Yahoo require it for bulk senders.

### Option 1 — Web GUI (recommended)

1. Open **Settings → DKIM Key Generation**
2. Enter your sending domain and a selector (default: `mail`)
3. Click **Generate DKIM Key**
4. The UI shows three DNS records to publish: **SPF**, **DKIM**, and **DMARC**
5. The private key is saved automatically at `dkim/<domain>.pem` and `config.json` is updated

### Option 2 — CLI script

```bash
npm run generate-dkim
# Follow the prompts — enter your sending domain and selector
```

This creates:
- `dkim/<domain>.pem` — keep this secret, never commit it
- Prints the DNS record to publish

> **Key path note:** The web UI and `generate-dkim` script both save keys as `dkim/<domain>.pem` (a flat file in the `dkim/` directory). The path in `config.json` must match exactly — it defaults to `"dkim/<domain>.pem"`.

**After generating, publish the DNS record:**
```bash
dig TXT mail._domainkey.yourdomain.com
```

**Verify DKIM is signing:**
- Send a test email and check the raw headers for `DKIM-Signature:`
- Or use a mail testing tool such as mail-tester.com

---

## Local MTA Relay Setup

A local MTA relay lets VPS Sender hand mail off to Postfix (Linux/macOS) or hMailServer (Windows), which then handles outbound queuing, retry, bounce handling, and TLS negotiation.

### Postfix (Linux / macOS)

The `install.sh` script handles this automatically at **Step 11**. Manual setup:

```bash
# Install Postfix
DEBIAN_FRONTEND=noninteractive apt-get install -y postfix

# Configure as loopback-only relay
postconf -e "inet_interfaces = loopback-only"
postconf -e "inet_protocols = ipv4"
postconf -e "mynetworks = 127.0.0.0/8"
postconf -e "myhostname = mail.yourdomain.com"
postconf -e "relayhost ="
postconf -e "smtp_tls_security_level = may"

systemctl enable postfix && systemctl restart postfix
```

Then set `config.json`:
```json
{
  "transport":      "relay",
  "relayHost":      "127.0.0.1",
  "relayPort":      25,
  "relayUser":      "",
  "relayPass":      "",
  "envelopeDomain": "mail.yourdomain.com",
  "preScanRelay":   false
}
```

Verify Postfix is accepting mail locally:
```bash
echo "test" | sendmail -v test@example.com
# Monitor queue:
mailq
postqueue -p
```

### hMailServer (Windows)

hMailServer requires manual installation (no silent install available). The `install.bat` **Step 11** guides you through this.

1. Download from [hmailserver.com/download](https://www.hmailserver.com/download)
2. Install, selecting **Server** type
3. Open **hMailServer Administrator** and:
   - **Domains** → **Add** → enter your sending domain
   - **Settings** → **Advanced** → **IP Ranges**: add `127.0.0.1–127.0.0.1`, enable **Allow SMTP relay**
   - **Settings** → **Protocols** → **SMTP** → **Delivery**: set your HELO hostname
4. For DKIM signing: generate a key via the web GUI Settings tab, then paste the private key into **Domains** → `<your domain>` → **DKIM Signing**

Then set `config.json`:
```json
{
  "transport":      "relay",
  "relayHost":      "127.0.0.1",
  "relayPort":      587,
  "relayUser":      "",
  "relayPass":      "",
  "envelopeDomain": "mail.yourdomain.com",
  "preScanRelay":   false
}
```

---

## Mailcow Integration

If you have [Mailcow](https://mailcow.email) installed on the same VPS:

1. **Mailcow listens on port 587** via docker-proxy — this is the submission port for authenticated sending
2. **Mailcow enforces `authenticated user = envelope sender`** — you must set `relayFromEmail` to match your Mailcow account
3. **Mailcow delivers from your VPS IP** — check your IP reputation in **Dashboard → IP Reputation Check** before sending

**Settings in `config.json`:**

```json
{
  "transport": "relay",
  "relayHost": "127.0.0.1",
  "relayPort": 587,
  "relayUser": "campaign@yourdomain.com",
  "relayPass": "your-mailcow-account-password",
  "relayFromEmail": "campaign@yourdomain.com",
  "preScanRelay": false
}
```

> The display `From:` can be any address. The `Sender:` header carries the Mailcow account address for DKIM alignment.

**DNS requirements for the Mailcow account domain:**
- SPF: `v=spf1 ip4:<your-vps-ip> ~all`
- DKIM: set up via Mailcow Admin → Mail Setup → DKIM
- PTR: your VPS IP should reverse-resolve to your domain (set in VPS control panel)

---

## Split-Header Signing

Split-header signing lets you use **any visible `From:` address** while maintaining proper SPF and DKIM alignment for deliverability.

**How it works:**

| Layer | Address | Purpose |
|-------|---------|---------|
| SMTP envelope `MAIL FROM` | `bounce@envelopeDomain` | SPF + DKIM alignment — this is what email servers authenticate |
| Email header `From:` | Address from `smtp.txt` | What the recipient sees in their email client |

When `envelopeDomain` is set in `config.json`:
- The SMTP handshake uses `MAIL FROM: <bounce@yourenvelopedomain.com>`
- Your SPF and DKIM records for `yourenvelopedomain.com` cover this address
- The visible `From:` header can be any address — a brand name, a different domain, etc.
- DKIM signs with `d=yourenvelopedomain.com`

**Example:**

```json
{ "envelopeDomain": "mail.myserver.com" }
```

SPF: `TXT mail.myserver.com "v=spf1 ip4:<your-vps-ip> ~all"`
DKIM: `TXT mail._domainkey.mail.myserver.com "v=DKIM1; k=rsa; p=<pubkey>"`
DMARC: `TXT _dmarc.mail.myserver.com "v=DMARC1; p=none; rua=mailto:dmarc@mail.myserver.com"`

All DNS records for `mail.myserver.com` — the `smtp.txt` `From:` can be anything.

> Leave `envelopeDomain` empty to use the sender's own domain for both envelope and header (standard mode).

---

## Relay From Email (Mailcow / Postal Pattern)

Some authenticated relays — Mailcow, Postal, and others — enforce that the SMTP envelope `MAIL FROM` must match the authenticated user. If you send from `alice@brand.com` but authenticate as `relay@myserver.com`, the relay rejects with `553 5.7.1 Sender address rejected: not owned by user`.

`relayFromEmail` solves this by separating the envelope sender from the display `From:`:

| Layer | Address | Purpose |
|-------|---------|---------|
| SMTP envelope `MAIL FROM` | `relayFromEmail` | What the relay authenticates — must match the relay account |
| Email header `Sender:` | `relayFromEmail` | DKIM/SPF anchor — receiving servers check this for alignment |
| Email header `From:` | Campaign sender (smtp.txt / Fixed / Unique) | What the recipient sees |

**Config example for Mailcow:**

```json
{
  "transport": "relay",
  "relayHost": "127.0.0.1",
  "relayPort": 587,
  "relayUser": "campaign@myserver.com",
  "relayPass": "yourpassword",
  "relayFromEmail": "campaign@myserver.com"
}
```

The display `From:` can be any address — a brand name, a different domain, etc. The `Sender:` header ensures DKIM/SPF validates against the relay account's domain.

---

## From Address Modes (Campaign Wizard)

Three modes control the `From:` address recipients see. Switch between them in the Campaign Wizard.

| Mode | Behavior |
|------|----------|
| **SMTP list** (default) | `From:` = `fromEmail` from `smtp.txt`, rotated per sender rotation interval |
| **Fixed** | Every recipient gets the same `From:` address — specify it in "Fixed From Email" |
| **Unique per recipient** | A random local-part is generated per recipient: `j.smith47@yourdomain.com`, `alex.white@yourdomain.com`, etc. You specify the domain. |

The **Sender Preview** box at the bottom of the Campaign Wizard shows both the current `From:` and `Sender:` values before you launch.

---

## Template Variables

Use `{{variable}}` in subject lines and HTML body files:

| Variable | Value |
|----------|-------|
| `{{email}}` | Full recipient address: `john@example.com` |
| `{{domain}}` | Recipient domain: `example.com` |
| `{{name}}` | Sender display name from `names.txt` |
| `{{unsubscribe_url}}` | One-click unsubscribe URL (requires `unsubscribeBaseUrl` in config) |

---

## Workspace File Reference

All files are resolved relative to the working directory. Manage them all from the **Workspace Files** tab.

### `mxemails.txt` — Sender Candidates
One email per line. The scanner checks each domain for MX, SPF, DMARC, and port 25.

### `recipients.txt` — Destination Leads
Any format — the tool auto-extracts valid email addresses via regex.

### `subjects.txt` — Email Subjects
One per line. Rotates round-robin across recipients.

### `names.txt` — Display Names
One per line. Rotates alongside subjects.

### `body.html` — Email Body
Standard HTML with optional template variables. Multiple body files rotate per recipient (select them in the Campaign Wizard).

### `smtp.txt` — Sender Config (auto-generated by scanner)
```
[SMTP.1]
enabled      = true
host         = mail.sender1.com
port         = 25
fromEmail    = alice@sender1.com
allowPooling = true

[SMTP.2]
enabled      = true
host         = mail.sender2.net
port         = 25
fromEmail    = bob@sender2.net
allowPooling = true
```

### `suppression.txt` — Unsubscribe List (optional)
One email per line. Addresses in this file are silently skipped before any campaign starts.

---

## CLI Mode

```bash
npm run cli
```

| Mode | Description |
|------|-------------|
| `1` Scanner only | Reads `mxemails.txt`, checks MX + port 25 + SPF + DMARC, saves `smtp.txt` |
| `2` Send only | Loads `smtp.txt`, picks files interactively, sends |
| `3` Scan + Send | Runs scanner then sends in one run |
| `4` Start Web GUI | Launches the web dashboard |

---

## Public Access & Remote Server

By default the GUI binds to `127.0.0.1` — accessible only via localhost or SSH tunnel. To expose it:

### Option 1 — via install script (recommended)
The install scripts ask during setup. Answer `y` when prompted for public binding and enter an API token.

### Option 2 — via Settings tab
1. Open **Settings** → **Server Access**
2. Set **Bind Address** to `0.0.0.0 — public network`
3. Set an **API Token** (strongly recommended)
4. Click **Save Configuration**
5. Restart: `pm2 restart vps-sender` or `npm start`

### Option 3 — edit `config.json` directly
```json
{
  "bindHost": "0.0.0.0",
  "port": 3000,
  "domain": "yourdomain.com",
  "apiToken": "your-secret-token"
}
```

### API Token Authentication
When `apiToken` is set, every request must include it as:
- Header: `X-API-Token: your-secret-token`
- Query string: `?token=your-secret-token` (sent automatically by the web GUI)

> **SSH tunnel alternative:**
> ```bash
> ssh -L 3000:localhost:3000 user@your-server-ip
> # then open http://localhost:3000 in your browser
> ```

---

## VPS Deployment

### PM2 (via install script — recommended)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
# Follow the printed command to enable auto-start on reboot
```

Useful commands:
```bash
pm2 status                  # show all processes
pm2 logs vps-sender         # live log stream
pm2 restart vps-sender      # restart (e.g. after config change)
pm2 stop vps-sender         # stop
```

### Docker

```bash
docker build -t vps-sender .
docker run -d \
  -p 127.0.0.1:3000:3000 \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/dkim:/app/dkim \
  -v $(pwd)/logs:/app/logs \
  --name vps-sender \
  vps-sender
```

---

## SOCKS5 Proxy

Route outbound SMTP through a SOCKS5 proxy when port 25 is blocked:

```
socks5://username:password@host:port
socks4://host:port
```

Set it via:
1. **Settings** tab → **SOCKS5 Proxy URL** field
2. CLI mode proxy prompt
3. `PROXY_URL` environment variable

> Proxy routing only applies in **direct** mode. In **relay** mode the local MTA handles outbound connections.

---

## Monitoring & Logging

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server status, uptime, engine state, OS platform |
| `/api/stream` | GET | SSE stream of live campaign events |
| `/api/export-csv` | GET | Download campaign results as CSV |
| `/api/config` | GET / POST | Read or write configuration |
| `/api/dkim/generate` | POST | Generate DKIM key pair and return DNS records |
| `/api/scan` | POST | Start a domain scanner run |
| `/api/campaign/start` | POST | Start a campaign |
| `/api/campaign/pause` | POST | Pause running campaign |
| `/api/campaign/resume` | POST | Resume paused campaign |
| `/api/campaign/stop` | POST | Cancel running campaign |
| `/api/campaign/clear-history` | POST | Delete all send history (SQLite + CSV) — lets you resend to the same recipients |
| `/api/test-send` | POST | Send a single test email to verify delivery settings |
| `/api/blacklist-check` | POST | Check sending IP against 8 DNSBL blocklists |

### Log Files

Structured JSON logs: `logs/vps-sender.log` (rotates at 10 MB).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web GUI port (overrides config) |
| `PROXY_URL` | — | SOCKS5 proxy (overrides config) |
| `SENDING_IP` | `auto` | Override auto-detected public IP |

```bash
PORT=8080 PROXY_URL=socks5://user:pass@1.2.3.4:1080 npm start
```

---

## Deliverability Checklist

1. **PTR record** — Set reverse DNS for your VPS IP to match `heloHost` in config
2. **SPF record** for your sending/envelope domain:
   ```
   TXT yourdomain.com "v=spf1 ip4:<your-vps-ip> ~all"
   ```
3. **DKIM** — Generate via Settings tab or `npm run generate-dkim`, publish the DKIM DNS record, verify `dkim/<domain>.pem` exists
4. **DMARC** record:
   ```
   TXT _dmarc.yourdomain.com "v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com"
   ```
5. **HELO/EHLO match** — `heloHost` should match the PTR record for your sending IP
6. **Unsubscribe link** — Set `unsubscribeBaseUrl` and include `{{unsubscribe_url}}` in body
7. **IP Reputation** — Use **Dashboard → IP Reputation Check → Check Now** to scan against 8 blocklists. If listed on Mailspike or Spamhaus, request delist before sending.
8. **Blacklist check (external)** — Also verify at [mxtoolbox.com/blacklists](https://mxtoolbox.com/blacklists)
9. **Test score** — Use [mail-tester.com](https://www.mail-tester.com) to verify full deliverability stack

> **Split-header users:** Publish SPF, DKIM, and DMARC for the `envelopeDomain` — not for the visible `From:` domain. The envelope domain is what receiving servers authenticate.

---

## Results & Resume

Every delivery attempt is logged to `results.csv`:

```csv
email,from_email,subject,smtp,status,error,tls
user@gmail.com,alice@sender.com,"Hello",[SMTP.1],sent,,true
user@yahoo.com,bob@sender.net,"Hello",[SMTP.2],failed,"550 User unknown",
```

**Resume:** On restart, already-sent addresses are automatically skipped. Safe to restart interrupted campaigns.

---

## Troubleshooting

**`npm install` fails on `better-sqlite3`**
Native bindings need build tools. Run the install script — it handles this automatically.

**"Nothing reachable to send"**
Port 25 is blocked. Test: `telnet gmail-smtp-in.l.google.com 25`. Use a VPS that allows port 25, configure a SOCKS5 proxy, or switch to relay mode.

**Emails go to spam**
Set up SPF, DKIM, and DMARC (see Deliverability Checklist). Check your IP at mxtoolbox.com/blacklists. Make sure `heloHost` matches your PTR record.

**Web GUI shows "SSE Offline"**
The server stopped. Restart: `npm start` or `pm2 restart vps-sender`.

**Port 3000 already in use**
`PORT=3001 npm start` or change `port` in `config.json`.

**GUI asks for a token I don't know**
Edit `config.json`, clear `apiToken`, restart.

**DKIM not signing**
Check that `privateKeyPath` in `config.json` (`dkim/<domain>.pem`) exists on disk. The domain must match the `fromEmail` domain exactly, or the `envelopeDomain` if split-header signing is enabled.

**Relay mode: "Connection refused" on 127.0.0.1**
Postfix or hMailServer is not running. On Linux: `systemctl status postfix`. On Windows: open Services and check hMailServer.

**Relay mode: mail queued but not delivered**
Check the MTA logs: `journalctl -u postfix` (Linux) or hMailServer logs at `C:\Program Files (x86)\hMailServer\Logs\`. Common cause: SPF/DKIM not configured on your sending domain, or IP blacklisted.

**Relay port mismatch**
Postfix loopback relay uses port **25**. hMailServer submission uses port **587**. Make sure `relayPort` in `config.json` matches.

**Split-header: DMARC failing**
The `envelopeDomain` must have both SPF and DKIM records, and DKIM must be signing with `d=envelopeDomain`. The visible `From:` domain does not need any DNS records.

**Rate limits JSON invalid**
If you edited Rate Limits in Settings and it reverted, check for JSON syntax errors — invalid JSON is silently skipped and the previous value is kept.
