# VPS Sender v2 — Direct-to-MX Email Sender

Send email **directly to recipient mail servers** — no third-party relay, no API keys, no monthly fees. Features rotating senders, DKIM signing, smart retries, rate limiting, SQLite state, and a live Web GUI dashboard fully manageable from the browser.

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
| Node.js missing | Auto-installs Node.js 20 LTS via **winget** |
| Build tools missing | Auto-installs Visual Studio Build Tools via winget |
| `npm install` | Installs all dependencies; retries with build tools if first attempt fails |
| Directories | Creates `logs\` and `dkim\` |
| Starter files | Creates `mxemails.txt`, `recipients.txt`, `subjects.txt`, `names.txt`, `body.html` if not present |
| Port 25 check | Tests outbound port 25 and tells you if it's open or blocked |
| Firewall | Adds Windows Firewall rule to allow inbound TCP on port 3000 |
| Public access | Prompts whether to bind to `0.0.0.0`; lets you set an API token |
| PM2 | Optionally installs PM2 and starts the server as a persistent background process |

**If winget isn't available** (older Windows):
1. Download and install Node.js 20 LTS from [nodejs.org](https://nodejs.org/en/download)
2. Re-run `install.bat`

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
| Build tools missing | Installs `build-essential` + `python3` |
| `npm install` | Installs all dependencies |
| Directories | Creates `logs/` and `dkim/` |
| Starter files | Creates all 5 starter files if not present |
| Port 25 check | Tests outbound port 25 using `nc` / `/dev/tcp` / `curl` |
| Firewall | Opens port 3000 in UFW (Ubuntu/Debian) or firewalld (Fedora/RHEL) |
| Public access | Prompts whether to bind to `0.0.0.0`; sets API token in `config.json` |
| PM2 | Optionally installs PM2, starts the server, and configures auto-start on reboot |

**Supported package managers:** `apt` (Ubuntu/Debian), `dnf` (Fedora/RHEL), `yum` (CentOS)

**Fresh Ubuntu VPS — exact commands:**
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
- Everything else is the same as Linux

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

### Campaign Wizard Tab
Configure before launching:
- Recipient file, names file, subjects file, HTML body file(s)
- SMTP config file (`smtp.txt`), optional attachments
- Rotate sender every N emails
- Resume mode (skip already-sent addresses)

### Domain Scanner Tab
Evaluate sender domains before committing to a campaign:
1. Pick your `mxemails.txt`
2. Toggle **Include WEAK domains**
3. Click **Start Scan** — results table shows MX, port 25 status, SPF, DMARC
4. Saves usable entries to `smtp.txt`

### Mail Previewer Tab
Preview your rendered email before sending — enter a test recipient, sender, and subject to see the final output with template variables applied.

### Workspace Files Tab
Full file management directly in the browser — no SSH required:

| Action | How |
|--------|-----|
| **Edit** | Click a file in the list → edit in the code pane → Save |
| **Create** | Click **+ New File** → enter a name |
| **Upload** | Click **↑ Upload** or drag files onto the editor panel |
| **Paste** | Open a file, click **📋 Paste** to paste clipboard content |
| **Download** | Select a file → click **↓ Download** |
| **Delete** | Select a file → click **🗑 Delete** |
| **Attachments** | Upload binary files (PDF, images, ZIP, DOCX) in the Attachments panel below the editor; download or delete them there too |

Drag-and-drop works on the editor panel — drop one or more files and they upload automatically. Text files open for editing immediately.

### Settings Tab
All `config.json` fields are configurable from the browser. Sections:

| Section | Fields |
|---------|--------|
| **General** | Proxy URL, send delay, greylist retry timeout, results file, HELO hostname, concurrency, unsubscribe URL, TLS validation |
| **Server Access** | Bind address, port, custom domain, API token, public URL display |
| **Sending Options** | Sending IP, direct-to-MX only, allow weak domains |
| **Send Warmup** | Enable warmup, daily limit, daily increment |
| **Rate Limits** | JSON editor for per-provider per-minute/per-hour caps |
| **DKIM Configuration** | JSON editor for DKIM key paths per domain |

---

## Public Access (Remote Server)

By default the GUI binds to `127.0.0.1` — accessible only via localhost or an SSH tunnel. To expose it on the public internet:

### Option 1 — via install script (recommended)
The install scripts ask during setup. Answer `y` when prompted for public binding and enter an API token.

### Option 2 — via Settings tab in the browser
1. Open **Settings & Proxy**
2. Set **Bind Address** to `0.0.0.0 — public network`
3. Set an **API Token** (strongly recommended — anyone who knows the URL can control the server otherwise)
4. Click **Save Configuration**
5. Restart the server: `pm2 restart vps-sender` or `npm start`

### Option 3 — edit `config.json` directly
```json
{
  "bindHost": "0.0.0.0",
  "port": 3000,
  "domain": "yourdomain.com",
  "apiToken": "your-secret-token"
}
```

Then restart the server.

### API Token authentication
When `apiToken` is set, every request must include it either as:
- Header: `X-API-Token: your-secret-token`
- Query string: `?token=your-secret-token` (used automatically by the browser GUI)

The browser GUI reads the token from Settings and sends it on all API calls automatically. Set it once and the UI stays authenticated.

> **SSH tunnel alternative:** If you don't want public access, use an SSH tunnel instead:
> ```bash
> ssh -L 3000:localhost:3000 user@your-server-ip
> # then open http://localhost:3000 in your browser
> ```

---

## Configuration (`config.json`)

Auto-created on first run with safe defaults. Edit by hand, via the Settings tab in the Web GUI, or via the install scripts.

```json
{
  "proxyUrl": "",
  "sendingIp": "auto",
  "heloHost": "mail.yourdomain.com",
  "allowWeakDomains": true,
  "directToMxOnly": true,
  "tlsRejectUnauthorized": true,
  "concurrency": 2,
  "sendDelay": 1500,
  "greylistWait": 60000,
  "resultsFile": "results.csv",
  "bindHost": "127.0.0.1",
  "port": 3000,
  "domain": "",
  "apiToken": "",
  "unsubscribeBaseUrl": "",
  "warmup": {
    "enabled": false,
    "dailyLimit": 100,
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

| Setting | Default | Description |
|---------|---------|-------------|
| `proxyUrl` | `""` | SOCKS5 proxy. Format: `socks5://user:pass@host:port` |
| `sendingIp` | `"auto"` | Source IP for outbound SMTP. `"auto"` detects it from the interface |
| `heloHost` | `"mail.localhost"` | Hostname in SMTP EHLO — should match your VPS PTR/rDNS |
| `allowWeakDomains` | `true` | Send from domains regardless of SPF/DMARC strength |
| `directToMxOnly` | `true` | Always connect directly to MX servers (skip relay) |
| `tlsRejectUnauthorized` | `true` | Verify MX TLS certificates. Set `false` for self-signed certs |
| `concurrency` | `2` | Parallel SMTP connections (1–5 recommended) |
| `sendDelay` | `1500` | Milliseconds between sends |
| `greylistWait` | `60000` | Ms to wait before retrying a `4xx` greylisting response |
| `resultsFile` | `"results.csv"` | CSV log of all delivery attempts |
| `bindHost` | `"127.0.0.1"` | GUI listen address. `"0.0.0.0"` = public |
| `port` | `3000` | TCP port the web GUI listens on |
| `domain` | `""` | Custom domain for CORS and the public URL shown in Settings |
| `apiToken` | `""` | Required `X-API-Token` header value. Empty = no auth |
| `unsubscribeBaseUrl` | `""` | Base URL for `List-Unsubscribe` and `{{unsubscribe_url}}` variable |
| `warmup.enabled` | `false` | Gradually increase volume each day to build sender reputation |
| `warmup.dailyLimit` | `100` | Max emails per day during warmup period |
| `warmup.incrementPerDay` | `50` | How much to raise the daily limit each day |
| `rateLimits` | see above | Per-provider token-bucket caps. Key = provider domain or `"default"` |
| `dkim` | `{}` | DKIM signing config keyed by sender domain (see DKIM Setup below) |

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

**Publish the DNS record**, then add to `config.json` (or paste via the DKIM section in Settings):

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

Verify propagation:
```bash
dig TXT mail._domainkey.yourdomain.com
```

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

All files are resolved relative to the working directory. Manage them all from the **Workspace Files** tab in the GUI.

### `mxemails.txt` — Sender Candidates
One email per line. The scanner checks each domain for MX, SPF, DMARC, and port 25.

### `recipients.txt` — Destination Leads
Any format — the tool auto-extracts valid email addresses.

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
```

### `suppression.txt` — Unsubscribe List (optional)
One email per line. Silently skipped before any campaign starts.

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

## VPS Deployment

### PM2 (via install script — recommended)

The install scripts prompt you during setup. To set it up manually:

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

If outbound port 25 is blocked, route through a SOCKS5 proxy:

```
socks5://username:password@host:port
socks4://host:port
```

Set it in three ways:
1. Settings tab → **SOCKS5 Proxy URL** field
2. CLI mode proxy prompt
3. `PROXY_URL` environment variable

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
| `PORT` | `3000` | Web GUI port (overrides config) |
| `PROXY_URL` | — | SOCKS5 proxy (overrides config) |
| `SENDING_IP` | `auto` | Override auto-detected public IP |

```bash
PORT=8080 PROXY_URL=socks5://user:pass@1.2.3.4:1080 npm start
```

---

## Deliverability Checklist

1. **PTR record** — Set reverse DNS for your VPS IP to match `heloHost` in config
2. **SPF record**
   ```
   TXT @ v=spf1 ip4:<your-vps-ip> ~all
   ```
3. **DKIM** — `npm run generate-dkim`, publish the DNS record, add path to config
4. **DMARC**
   ```
   TXT _dmarc v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com
   ```
5. **Unsubscribe** — Set `unsubscribeBaseUrl` and include `{{unsubscribe_url}}` in body

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
Port 25 is blocked. Test: `telnet gmail-smtp-in.l.google.com 25`. Use a VPS or SOCKS5 proxy.

**Emails go to spam**  
Set up SPF, DKIM, and DMARC (see Deliverability Checklist above). Check your IP at mxtoolbox.com/blacklists.

**Web GUI shows "SSE Offline"**  
The server stopped. Restart: `npm start` or `pm2 restart vps-sender`.

**Port 3000 already in use**  
`PORT=3001 npm start` or change `port` in `config.json`.

**GUI asks for a token I don't know**  
Edit `config.json` and clear `apiToken`, then restart.

**DKIM not signing**  
Check that `privateKeyPath` in `config.json` points to an existing `.pem` file and the domain matches the `fromEmail` domain exactly.

**Rate limits JSON invalid**  
If you edited Rate Limits in Settings and saved, check the JSON syntax — invalid JSON is silently skipped and the previous value is kept.
