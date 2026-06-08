# VPS Sender — Deployment Guide

## Prerequisites

- Node.js 18+ (20 LTS recommended)
- Port 25 outbound open on your VPS
- Domain with DNS control (for best deliverability)

## Quick Start (Local)

```bash
npm install
npm start        # opens http://localhost:3000
# or
npm run cli      # interactive CLI mode
```

## VPS Deployment with PM2

```bash
npm install -g pm2
npm install
pm2 start ecosystem.config.js
pm2 save
pm2 startup      # auto-start on reboot
```

## Docker

```bash
docker build -t vps-sender .
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/dkim:/app/dkim \
  -v $(pwd)/logs:/app/logs \
  --name vps-sender \
  vps-sender
```

## Systemd Unit (alternative to PM2)

```ini
# /etc/systemd/system/vps-sender.service
[Unit]
Description=VPS Sender Direct-to-MX Mailer
After=network.target

[Service]
Type=simple
User=sender
WorkingDirectory=/opt/vps-sender
ExecStart=/usr/bin/node vps-sender.js --gui
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable vps-sender
systemctl start vps-sender
systemctl status vps-sender
```

## Configuration (`config.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `bindHost` | `127.0.0.1` | Web GUI bind address. Set to `0.0.0.0` to expose publicly (add firewall rules) |
| `apiToken` | `""` | Set a token to require `X-API-Token` header on all API calls |
| `heloHost` | `mail.localhost` | Hostname to present in SMTP EHLO — should match your server's PTR record |
| `tlsRejectUnauthorized` | `true` | Verify MX TLS certificates. Set `false` only if connecting to servers with self-signed certs |
| `allowWeakDomains` | `true` | Allow sending regardless of SPF/DMARC status (with warnings) |
| `concurrency` | `2` | Parallel sends (1–5 recommended) |
| `sendDelay` | `1500` | Milliseconds between sends |

## DKIM Setup

```bash
npm run generate-dkim
# Follow the prompts, then add the DNS TXT record shown
```

## Deliverability Checklist

1. **PTR record** — Set reverse DNS for your VPS IP to match `heloHost`
2. **SPF** — `v=spf1 ip4:<your-ip> ~all`
3. **DKIM** — Run `npm run generate-dkim`, publish the DNS TXT record
4. **DMARC** — `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`
5. **Port 25** — Confirm outbound port 25 is open: `telnet gmail-smtp-in.l.google.com 25`

## Monitoring

- Web GUI: `http://localhost:3000`
- Health: `GET http://localhost:3000/api/health`
- Logs: `logs/vps-sender.log` (JSON, rotated at 10 MB)
- PM2: `pm2 logs vps-sender`
