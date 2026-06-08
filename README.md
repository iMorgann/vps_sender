# VPS Sender v2 — Direct-to-MX Email Sender

Send email **directly to recipient mail servers** — no third-party relay, no API keys, no monthly fees. Features rotating senders, DKIM signing, smart retries, rate limiting, SQLite state, and a live Web GUI dashboard.

---

## Requirements

| | |
|---|---|
| **Node.js** | v18 or newer — **the install scripts install it for you** |
| **OS** | Windows 10/11, Ubuntu/Debian, Fedora/RHEL/CentOS, macOS |
| **Network** | Outbound **port 25** must be open (the scripts check this too) |

> **Port 25:** Most home ISPs and cloud providers (AWS, GCP, Azure, DigitalOcean) block port 25. Use a VPS that allows SMTP — Hetzner, OVH, Contabo, or Vultr — or configure a SOCKS5 proxy in the Settings tab.

---

## Installation

### Windows

Double-click **`install.bat`**, or right-click it and choose **Run as administrator** for best results.

```
install.bat
```

The script handles everything automatically:

| Step | What happens |
|------|-------------|
| Node.js missing | Auto-installs Node.js 20 LTS via **winget** (built into Windows 10/11) |
| Build tools missing | Auto-installs Visual Studio Build Tools via winget (needed for SQLite) |
| `npm install` | Installs all dependencies; retries with build tools if first attempt fails |
| Directories | Creates `logs\` and `dkim\` |
| Starter files | Creates `mxemails.txt`, `recipients.txt`, `subjects.txt`, `names.txt`, `body.html` if not present |
| Port 25 check | Tests outbound port 25 and tells you if it's open or blocked |

**If winget isn't available** (older Windows):
1. Download and install Node.js 20 LTS from [nodejs.org](https://nodejs.org/en/download)
2. Re-run `install.bat`

**If `npm install` still fails** after the script tries to fix build tools:
```bat
:: Option A — install build tools manually, then re-run
winget install Microsoft.VisualStudio.2022.BuildTools

:: Option B — skip native compilation (SQLite disabled, everything else works)
npm install --ignore-scripts
```

---

### Linux / Ubuntu / Debian (including fresh VPS)

Works as **root** (typical fresh VPS) or as a normal user with `sudo`:

```bash
bash install.sh
```

> No need to `chmod` first — just run it with `bash`.

The script handles everything automatically:

| Step | What happens |
|------|-------------|
| `curl` missing | Installs curl via the system package manager |
| Node.js missing / outdated | Adds the NodeSource repo and installs Node.js 20 LTS |
| Build tools missing | Installs `build-essential` + `python3` (needed for SQLite) |
| `apt-get update` | Runs automatically before any package installs |
| `npm install` | Installs all dependencies |
| Directories | Creates `logs/` and `dkim/` |
| Starter files | Creates all 5 starter files if not present |
| Port 25 check | Tests outbound port 25 using `nc` / `/dev/tcp` / `curl` |
| UFW firewall | Detects if UFW is active and tells you how to expose the GUI port |

**Supported package managers:** `apt` (Ubuntu/Debian), `dnf` (Fedora/RHEL), `yum` (CentOS)

**Fresh Ubuntu VPS — exact commands:**
```bash
# Upload or clone the project, then:
cd vps-sender
bash install.sh
npm start
```

**If you're behind a corporate firewall or apt is slow:**
```bash
# You can also install Node.js manually first, then run the script
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3
bash install.sh
```

---

### macOS

```bash
bash install.sh
```

- Installs Node.js via Homebrew if missing (`brew install node@20`)
- Prompts to install Xcode Command Line Tools if build tools are missing
- Everything else is the same as Linux

---

### Manual (any platform)

If you prefer to do it yourself:

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

### 1. Prepare your files

Place these in the project folder:

| File | What goes in it |
|------|----------------|
| `mxemails.txt` | Your sender email addresses (one per line) |
| `recipients.txt` | Destination addresses to send to |
| `subjects.txt` | Email subjects, one per line (rotates) |
| `names.txt` | Sender display names, one per line (rotates) |
| `body.html` | Your HTML email body |

### 2. Launch the Web GUI

```bash
npm start
```

Opens **http://localhost:3000** automatically.

### 3. Or use the interactive CLI

```bash
npm run cli
```

Pick a mode:
```
1  Scanner only   — scan mxemails.txt → save smtp.txt
2  Send only      — load smtp.txt + send
3  Scan + Send    — do both in one run
4  Start Web GUI
```

---

## DKIM Setup (Recommended)

DKIM signs your outgoing mail cryptographically. Gmail and Yahoo require it for bulk senders.

```bash
npm run generate-dkim
# Follow the prompts — enter your sending domain and selector (default: mail)
```

This creates:
- `dkim/yourdomain.com/private.pem` — keep this secret, never commit it
- `dkim/yourdomain.com/dns.txt` — the DNS TXT record to publish

**Publish the DNS record**, then add to `config.json`:

```json
{
  "dkim": {
    "yourdomain.com": {
      "domainName": "yourdomain.com",
      "keySelector": "mail",
      "privateKeyPath": "./dkim/yourdomain.com/private.pem"
    }
  }
}
```

Verify it propagated:
```bash
dig TXT mail._domainkey.yourdomain.com
```

---

## Configuration (`config.json`)

Auto-created on first run with safe defaults. Edit by hand or via the Settings tab in the Web GUI.

```json
{
  "proxyUrl": "",
  "sendingIp": "auto",
  "heloHost": "mail.yourdomain.com",
  "allowWeakDomains": true,
  "tlsRejectUnauthorized": true,
  "concurrency": 2,
  "sendDelay": 1500,
  "greylistWait": 60000,
  "resultsFile": "results.csv",
  "apiToken": "",
  "bindHost": "127.0.0.1",
  "unsubscribeBaseUrl": "https://yourdomain.com/unsubscribe",
  "dkim": {},
  "rateLimits": {
    "default":      { "perMinute": 30, "perHour": 500 },
    "gmail.com":    { "perMinute": 10, "perHour": 200 },
    "outlook.com":  { "perMinute": 10, "perHour": 200 }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `heloHost` | `mail.localhost` | Hostname presented in SMTP EHLO — should match your server's PTR/rDNS record |
| `allowWeakDomains` | `true` | Send from any domain regardless of SPF/DMARC (shows warnings) |
| `tlsRejectUnauthorized` | `true` | Verify MX TLS certificates. Set `false` only if connecting to servers with self-signed certs |
| `concurrency` | `2` | Parallel sends (1–5 recommended) |
| `sendDelay` | `1500` | Milliseconds between sends (sequential mode) |
| `greylistWait` | `60000` | Ms to wait before retrying a `4xx` greylisting response |
| `bindHost` | `127.0.0.1` | Web GUI listen address. Set to `0.0.0.0` to expose on LAN (add firewall rules) |
| `apiToken` | `""` | Require `X-API-Token` header on all API calls (leave empty to disable) |
| `unsubscribeBaseUrl` | `""` | Base URL for `List-Unsubscribe` header and `{{unsubscribe_url}}` template var |
| `rateLimits` | see above | Per-provider per-minute and per-hour caps |

---

## Template Variables

Use `{{variable}}` in subject lines and HTML body files:

| Variable | Value |
|----------|-------|
| `{{email}}` | Full recipient address: `john@example.com` |
| `{{domain}}` | Recipient domain: `example.com` |
| `{{name}}` | Sender display name from `names.txt` |
| `{{unsubscribe_url}}` | One-click unsubscribe URL (requires `unsubscribeBaseUrl` in config) |

**Example subject:**
```
We noticed your site at {{domain}} — quick question
```

**Example body:**
```html
<p>Hi there,</p>
<p>We came across <strong>{{domain}}</strong> and wanted to reach out.</p>
<p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>
```

---

## Workspace File Reference

All files are resolved relative to the working directory.

### `mxemails.txt` — Sender Candidates
One email per line. The scanner checks each domain for MX, SPF, DMARC, and port 25.
```
alice@yourdomain.com
bob@anotherdomain.net
```

### `recipients.txt` — Destination Leads
Any format — the tool auto-extracts valid email addresses.
```
user1@gmail.com
user2@yahoo.com, user3@hotmail.com
"John Doe" <johndoe@example.com>
```

### `subjects.txt` — Email Subjects
One per line. Rotates round-robin across recipients.
```
Quick question about {{domain}}
Following up — important update
Your exclusive offer is ready
```

### `names.txt` — Display Names
One per line. Rotates alongside subjects.
```
Michael
Sarah
David
```

### `body.html` — Email Body
Standard HTML with optional template variables. You can select multiple body files in the Campaign Wizard — they rotate per recipient.

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
fromEmail    = bob@sender2.net
allowPooling = true
```

### `suppression.txt` — Unsubscribe List (optional)
One email per line. These addresses are silently skipped before any campaign starts.
```
optout@example.com
noemail@domain.com
```

---

## Web GUI

```bash
npm start
# opens http://localhost:3000
```

### Dashboard Tab
Real-time campaign control:
- **Stats** — Sent / Failed / Dropped / Greylisted counts
- **Progress bar** — Completion percentage with ETA
- **Controls** — Start / Pause / Resume / Stop
- **Live log** — Color-coded stream of every delivery attempt
- **Chart** — Donut breakdown of results

Engine states:

| Badge | Meaning |
|-------|---------|
| Idle | No campaign running |
| Scanning | MX/port 25 pre-scan |
| Sending | Active delivery |
| Paused | User-paused or waiting on greylist retry |
| Done | Campaign finished |

### Campaign Wizard Tab
Configure before launching:
- Recipient file, names file, subjects file, HTML body file(s)
- SMTP config file (`smtp.txt`)
- Optional attachments
- Rotate sender every N emails
- Resume mode (skip already-sent addresses)

### Domain Scanner Tab
Evaluate sender domains before committing to a campaign:
1. Pick your `mxemails.txt`
2. Toggle **Include WEAK domains**
3. Click **Start Scan** — results table shows MX, port 25 status, SPF, DMARC
4. Saves usable entries to `smtp.txt`

### Sender Health Tab
Check a single domain's full deliverability status:
- SPF record strength
- DKIM public key presence
- DMARC policy
- PTR / rDNS record for your sending IP
- Clear **Green / Yellow** status with actionable tips

### Mail Previewer Tab
Preview your rendered email before sending — enter a test recipient, sender, and subject to see the final output with template variables applied.

### Workspace Files Tab
Browse and edit any file in the working directory directly in the browser. Save changes instantly.

### Settings Tab
Adjust proxy, delays, HELO hostname, TLS settings, and rate limits. All saved to `config.json`.

---

## CLI Mode

```bash
npm run cli
```

### Mode 1 — Scanner Only
Reads `mxemails.txt`, checks MX + port 25 + SPF + DMARC, saves `smtp.txt`.

### Mode 2 — Send Only
Interactive file picker: loads `smtp.txt`, picks recipient/subject/name/body files, optionally resumes from `results.csv`.

### Mode 3 — Scan + Send
Runs the scanner, then immediately sends.

---

## Deliverability Checklist

For best inbox placement when sending from your own domain:

1. **PTR record** — Set reverse DNS for your VPS IP to match `heloHost` in config  
   _Contact your hosting provider's support_

2. **SPF record** — Tell receiving servers your IP is authorized  
   ```
   TXT @ v=spf1 ip4:<your-vps-ip> ~all
   ```

3. **DKIM** — Cryptographic signature on every email  
   ```bash
   npm run generate-dkim
   # Publish the DNS TXT record shown, add key path to config.json
   ```

4. **DMARC** — Policy for what happens when SPF/DKIM fails  
   ```
   TXT _dmarc v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com
   ```
   Start with `p=none` (monitor only) and move to `quarantine` once DKIM is confirmed working.

5. **Unsubscribe** — Required by Gmail + Yahoo for bulk senders  
   Set `unsubscribeBaseUrl` in config and include `{{unsubscribe_url}}` in your email body.

> `allowWeakDomains: true` (the default) means the tool will send regardless of DNS auth status — it shows warnings but never blocks. Fix the DNS records for better inbox rates.

---

## Results & Resume

Every delivery attempt is logged to `results.csv` (and to `campaign.db` via SQLite):

```csv
email,from_email,subject,smtp,status,error,tls
user@gmail.com,alice@sender.com,"Hello",[SMTP.1],sent,,true
user@yahoo.com,bob@sender.net,"Hello",[SMTP.2],failed,"550 User unknown",
user@aol.com,,,,skipped,port 25 blocked,
```

**Resume:** If `results.csv` / `campaign.db` exists when you start, already-sent addresses are automatically skipped. Safe to restart interrupted campaigns.

**Export CSV from GUI:** `GET /api/export-csv?campaign=default`

---

## SOCKS5 Proxy

If outbound port 25 is blocked on your machine, route through a SOCKS5 proxy:

```
socks5://username:password@host:port
socks4://host:port
```

Set it in three ways:
1. Enter at the proxy prompt in CLI mode
2. Set in the Settings tab of the Web GUI
3. Set `PROXY_URL` environment variable

The proxy is used for all connections — MX probes, port 25 checks, and SMTP delivery.

---

## VPS Deployment

### PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
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

See [docs/DEPLOY.md](docs/DEPLOY.md) for systemd unit example and full deployment notes.

---

## Monitoring

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server status, uptime, engine state |
| `GET /api/stream` | SSE stream of live campaign events |
| `GET /api/export-csv` | Download campaign results as CSV |

Structured JSON logs: `logs/vps-sender.log` (rotates at 10 MB).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web GUI port |
| `PROXY_URL` | — | SOCKS5 proxy (overrides config) |
| `SENDING_IP` | `auto` | Override auto-detected public IP |

```bash
PORT=8080 PROXY_URL=socks5://user:pass@1.2.3.4:1080 npm start
```

---

## How Direct-to-MX Works

```
Your server
   │
   ├─ DNS MX lookup: example.com → mail.example.com
   │
   ├─ TCP connect → mail.example.com:25
   │
   ├─ SMTP handshake
   │     EHLO mail.yourdomain.com        ← your heloHost
   │     STARTTLS (TLS upgrade if offered)
   │     MAIL FROM:<alice@yourdomain.com>
   │     RCPT TO:<recipient@example.com>
   │     DATA → [MIME message with DKIM signature]
   │     QUIT
   │
   └─ Result → results.csv + campaign.db
```

**Rotation:** After every N emails the tool switches to the next sender in `smtp.txt`.  
**Greylisting:** On a `4xx` response the tool waits `greylistWait` ms and retries up to 3 times.  
**Rate limiting:** Per-provider token-bucket limits (configurable) prevent throttling.

---

## Troubleshooting

**`npm install` fails on `better-sqlite3`**  
Native bindings need build tools. On Linux: `apt install python3 make g++`. On Windows: install [windows-build-tools](https://github.com/nodejs/node-gyp#on-windows).

**"Nothing reachable to send"**  
Port 25 is blocked. Test: `telnet gmail-smtp-in.l.google.com 25`. Use a VPS or SOCKS5 proxy with port 25 open.

**Emails go to spam**  
Set up SPF, DKIM, and DMARC as described in the [Deliverability Checklist](#deliverability-checklist). Check your sending IP's reputation at [mxtoolbox.com/blacklists](https://mxtoolbox.com/blacklists.aspx).

**Web GUI shows "SSE Offline"**  
The server stopped. Restart: `npm start`.

**Port 3000 already in use**  
`PORT=3001 npm start`

**Results CSV blank during campaign**  
Don't open it in Excel while sending — Excel locks the file on Windows. Use a text editor.

**DKIM not signing**  
Check that `privateKeyPath` in `config.json` points to an existing `.pem` file and the domain matches the `fromEmail` domain exactly.
