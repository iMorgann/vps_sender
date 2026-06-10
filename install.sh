#!/usr/bin/env bash
# VPS Sender v2 — Setup script
# Supports: Ubuntu, Debian, Fedora, RHEL/CentOS, macOS
# Works as root (fresh VPS) or as a normal user with sudo

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e " ${GREEN}[OK]${RESET}    $*"; }
warn() { echo -e " ${YELLOW}[WARN]${RESET}  $*"; }
err()  { echo -e "\n ${RED}[ERROR]${RESET} $*\n"; }
info() { echo -e " ${CYAN}[--]${RESET}    $*"; }
step() { echo -e "\n${BOLD}$*${RESET}"; }

echo -e "\n${BOLD} ============================================================"
echo   "  VPS Sender v2  |  Direct-to-MX Email Sender"
echo   "  Setup Script for Linux / macOS"
echo   " ============================================================${RESET}\n"

# ── Root vs sudo ──────────────────────────────────────────────────────────────
# On a fresh VPS you're often root. Avoid breaking sudo calls.
if [[ $EUID -eq 0 ]]; then
    SUDO=""
    info "Running as root"
else
    SUDO="sudo"
    info "Running as $(whoami) (will use sudo where needed)"
fi

# ── Detect OS / package manager ───────────────────────────────────────────────
PKG=""
if   command -v apt-get &>/dev/null; then PKG="apt"
elif command -v dnf     &>/dev/null; then PKG="dnf"
elif command -v yum     &>/dev/null; then PKG="yum"
elif command -v brew    &>/dev/null; then PKG="brew"
fi

OS="linux"
if [[ "$OSTYPE" == "darwin"* ]]; then OS="mac"; fi

info "OS: $OS | Package manager: ${PKG:-none detected}"

# ── Helper: run with or without sudo ─────────────────────────────────────────
run() { $SUDO "$@"; }

# ── 1. Ensure curl is available ───────────────────────────────────────────────
step "1. Checking curl..."

if ! command -v curl &>/dev/null; then
    warn "curl not found — installing..."
    if   [[ "$PKG" == "apt" ]]; then run apt-get update -qq && run apt-get install -y curl
    elif [[ "$PKG" == "dnf" ]]; then run dnf install -y curl
    elif [[ "$PKG" == "yum" ]]; then run yum install -y curl
    else
        err "Cannot install curl automatically. Please install it and re-run."
        exit 1
    fi
fi
ok "curl $(curl --version | head -1 | awk '{print $2}')"

# ── 2. Node.js install / upgrade ─────────────────────────────────────────────
step "2. Checking Node.js..."

MIN_NODE=18
NODE_OK=false

if command -v node &>/dev/null; then
    NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
    NODE_MAJOR=${NODE_VER%%.*}
    if (( NODE_MAJOR >= MIN_NODE )); then
        NODE_OK=true
        ok "Node.js $NODE_VER already installed"
    else
        warn "Node.js $NODE_VER found but $MIN_NODE+ is required — upgrading..."
    fi
fi

if [[ "$NODE_OK" == "false" ]]; then
    info "Installing Node.js 20 LTS..."

    if [[ "$OS" == "linux" ]]; then
        if [[ "$PKG" == "apt" ]]; then
            # Update package lists first (critical on fresh VPS)
            info "Running apt-get update..."
            run apt-get update -qq

            info "Adding NodeSource repository..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | ${SUDO:+$SUDO -E} bash - 2>&1 | grep -v "^$" | sed 's/^/  /' || true
            run apt-get install -y nodejs

        elif [[ "$PKG" == "dnf" ]]; then
            run dnf module enable -y nodejs:20 2>/dev/null || true
            curl -fsSL https://rpm.nodesource.com/setup_20.x | ${SUDO:+$SUDO} bash -
            run dnf install -y nodejs

        elif [[ "$PKG" == "yum" ]]; then
            curl -fsSL https://rpm.nodesource.com/setup_20.x | ${SUDO:+$SUDO} bash -
            run yum install -y nodejs

        else
            err "Cannot auto-install Node.js — no supported package manager found."
            err "Install Node.js 20 manually: https://nodejs.org/en/download"
            err "Then re-run: bash install.sh"
            exit 1
        fi

    elif [[ "$OS" == "mac" ]]; then
        if command -v brew &>/dev/null; then
            info "Installing Node.js via Homebrew..."
            brew install node@20 || brew upgrade node@20 || true
            brew link --overwrite --force node@20 2>/dev/null || true
            # Update PATH immediately so command -v node works in this shell session.
            # node@20 is keg-only — brew does not link it into PATH automatically.
            BREW_NODE_BIN="$(brew --prefix node@20 2>/dev/null)/bin"
            [[ -d "$BREW_NODE_BIN" ]] && export PATH="$BREW_NODE_BIN:$PATH"
            hash -r 2>/dev/null || true
        else
            err "Homebrew not found. Install it first:"
            err "  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
            err "Then re-run: bash install.sh"
            exit 1
        fi
    fi

    # Verify install worked
    if ! command -v node &>/dev/null; then
        err "Node.js installation failed. Check the output above."
        exit 1
    fi

    NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
    ok "Node.js $NODE_VER installed"
fi

# npm check
if ! command -v npm &>/dev/null; then
    # npm sometimes lands in a separate package on older distros
    if [[ "$PKG" == "apt" ]]; then run apt-get install -y npm; fi
fi
ok "npm $(npm -v)"

# ── 3. Build tools for better-sqlite3 ────────────────────────────────────────
step "3. Checking build tools (needed for better-sqlite3 native module)..."

BUILT=true
if [[ "$OS" == "linux" ]]; then
    if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null || ! command -v python3 &>/dev/null; then
        BUILT=false
        info "Installing build tools..."
        if [[ "$PKG" == "apt" ]]; then
            run apt-get install -y build-essential python3
        elif [[ "$PKG" == "dnf" ]]; then
            run dnf install -y gcc-c++ make python3
        elif [[ "$PKG" == "yum" ]]; then
            run yum install -y gcc-c++ make python3
        else
            warn "Could not auto-install build tools. If npm install fails, run:"
            warn "  sudo apt install build-essential python3   # Debian/Ubuntu"
            warn "  sudo dnf install gcc-c++ make python3      # Fedora/RHEL"
        fi
    fi
elif [[ "$OS" == "mac" ]]; then
    if ! xcode-select -p &>/dev/null 2>&1; then
        BUILT=false
        warn "Xcode Command Line Tools not found."
        info "Attempting install (a dialog may appear — click Install)..."
        xcode-select --install 2>/dev/null || true
        warn "After the install completes, re-run: bash install.sh"
        exit 0
    fi
fi

ok "Build tools ready"

# ── 4. npm install ────────────────────────────────────────────────────────────
step "4. Installing npm dependencies..."
info "This may take 1–2 minutes (better-sqlite3 compiles a native binary)"
echo ""

if ! npm install; then
    echo ""
    err "npm install failed."
    echo -e " Possible fixes:"
    echo -e "   ${YELLOW}Ubuntu/Debian:${RESET} sudo apt install build-essential python3 && bash install.sh"
    echo -e "   ${YELLOW}Fedora/RHEL:${RESET}   sudo dnf install gcc-c++ make python3 && bash install.sh"
    echo -e "   ${YELLOW}macOS:${RESET}         xcode-select --install && bash install.sh"
    echo ""
    exit 1
fi

ok "Dependencies installed"

# ── 5. Runtime directories ────────────────────────────────────────────────────
step "5. Creating runtime directories..."
mkdir -p logs dkim
ok "logs/ and dkim/ ready"

# ── 6. Scaffold starter files ─────────────────────────────────────────────────
step "6. Checking starter files..."

if [[ ! -f mxemails.txt ]]; then
    cat > mxemails.txt << 'HEREDOC'
# Your sender email addresses — one per line
# The scanner checks each domain for MX, SPF, DMARC, and port 25
#
# alice@yourdomain.com
# bob@anotherdomain.net
HEREDOC
    ok "Created mxemails.txt"
else
    info "mxemails.txt already exists — skipped"
fi

if [[ ! -f recipients.txt ]]; then
    cat > recipients.txt << 'HEREDOC'
# Destination email addresses — one per line
# Any format works (the tool auto-extracts valid addresses):
#   user@example.com
#   "John Doe" <john@example.com>
#   user1@a.com, user2@b.com
HEREDOC
    ok "Created recipients.txt"
else
    info "recipients.txt already exists — skipped"
fi

if [[ ! -f subjects.txt ]]; then
    cat > subjects.txt << 'HEREDOC'
Quick question about {{domain}}
Following up — important update
Your exclusive offer is ready
HEREDOC
    ok "Created subjects.txt"
else
    info "subjects.txt already exists — skipped"
fi

if [[ ! -f names.txt ]]; then
    cat > names.txt << 'HEREDOC'
Michael
Sarah
David
HEREDOC
    ok "Created names.txt"
else
    info "names.txt already exists — skipped"
fi

if [[ ! -f body.html ]]; then
    cat > body.html << 'HEREDOC'
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <p>Hi there,</p>
  <p>We noticed your domain <strong>{{domain}}</strong> and wanted to reach out.</p>
  <p>Reply any time — we'd love to connect.</p>
  <p style="font-size:11px;color:#999;">
    <a href="{{unsubscribe_url}}">Unsubscribe</a>
  </p>
</body>
</html>
HEREDOC
    ok "Created body.html"
else
    info "body.html already exists — skipped"
fi

# ── 7. Port 25 check ──────────────────────────────────────────────────────────
step "7. Checking outbound port 25..."

PORT25_OPEN=false
PORT25_METHOD=""

# Method 1: nc (netcat)
if command -v nc &>/dev/null; then
    if nc -z -w 5 gmail-smtp-in.l.google.com 25 2>/dev/null; then
        PORT25_OPEN=true; PORT25_METHOD="nc"
    fi
fi

# Method 2: /dev/tcp bash built-in
if [[ "$PORT25_OPEN" == "false" ]] && [[ "$OS" == "linux" ]]; then
    if timeout 6 bash -c 'echo >/dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then
        PORT25_OPEN=true; PORT25_METHOD="bash"
    fi
fi

# Method 3: curl SMTP probe
if [[ "$PORT25_OPEN" == "false" ]] && command -v curl &>/dev/null; then
    if curl -s --max-time 6 --connect-timeout 6 \
        "smtp://gmail-smtp-in.l.google.com:25" \
        --output /dev/null 2>/dev/null; then
        PORT25_OPEN=true; PORT25_METHOD="curl"
    fi
fi

if [[ "$PORT25_OPEN" == "true" ]]; then
    ok "Port 25 is OPEN — you can send directly to MX servers"
else
    warn "Port 25 appears BLOCKED on this machine."
    echo ""
    echo -e "   Most ISPs and cloud providers (AWS, GCP, Azure, DigitalOcean)"
    echo -e "   block outbound port 25 by default."
    echo ""
    echo -e "   ${BOLD}Solutions:${RESET}"
    echo -e "   1. Use a VPS provider that allows SMTP:"
    echo -e "      ${CYAN}Hetzner, OVH, Contabo, Vultr, Hostinger${RESET}"
    echo -e "   2. Request port 25 unblock from your current provider"
    echo -e "   3. Configure a SOCKS5 proxy in the Web GUI Settings tab"
    echo ""
fi

# ── 8. Firewall — all platforms ──────────────────────────────────────────────
step "8. Firewall check for port 3000..."

if [[ "$OS" == "linux" ]]; then
    # ── UFW (Ubuntu/Debian) ──────────────────────────────────────────────────
    if command -v ufw &>/dev/null; then
        UFW_STATUS=$(ufw status 2>/dev/null | head -1 || true)
        if echo "$UFW_STATUS" | grep -q "active"; then
            info "UFW is active — opening port 3000..."
            run ufw allow 3000/tcp comment "vps-sender web GUI" 2>/dev/null && \
                ok "UFW: port 3000 allowed" || \
                warn "Could not open port 3000 in UFW. Run: sudo ufw allow 3000"
        else
            info "UFW is inactive — no firewall rule needed"
        fi
    fi

    # ── firewalld (Fedora / RHEL / CentOS) ──────────────────────────────────
    if command -v firewall-cmd &>/dev/null; then
        if firewall-cmd --state 2>/dev/null | grep -q "running"; then
            info "firewalld is active — opening port 3000..."
            run firewall-cmd --permanent --add-port=3000/tcp 2>/dev/null && \
            run firewall-cmd --reload 2>/dev/null && \
                ok "firewalld: port 3000 allowed" || \
                warn "Could not open port. Run: sudo firewall-cmd --permanent --add-port=3000/tcp && sudo firewall-cmd --reload"
        else
            info "firewalld is inactive — no firewall rule needed"
        fi
    fi

    # ── iptables fallback ────────────────────────────────────────────────────
    if ! command -v ufw &>/dev/null && ! command -v firewall-cmd &>/dev/null; then
        if command -v iptables &>/dev/null; then
            warn "No ufw/firewalld found. If port 3000 is blocked, run:"
            warn "  iptables -A INPUT -p tcp --dport 3000 -j ACCEPT"
        fi
    fi

elif [[ "$OS" == "mac" ]]; then
    info "macOS: Application Firewall usually allows inbound connections."
    info "If port 3000 is blocked, go to System Settings → Firewall → Allow node."
fi
ok "Firewall step complete"

# ── 9. Web GUI access ─────────────────────────────────────────────────────────
step "9. Web GUI access..."

BIND_PUBLIC="n"
API_TOKEN=""

if [[ -t 0 ]]; then
    echo ""
    echo -e "  The web GUI defaults to ${BOLD}localhost (127.0.0.1)${RESET} — safe for local use."
    echo -e "  To reach it from a browser on another machine, bind to 0.0.0.0."
    echo ""
    read -rp "  Bind GUI to public network (0.0.0.0)? [y/N]: " BIND_PUBLIC
fi

if [[ "$BIND_PUBLIC" =~ ^[Yy]$ ]]; then
    echo ""
    warn "Public binding enabled. An API token is STRONGLY recommended."
    if [[ -t 0 ]]; then
        read -rp "  Set API token (leave blank to skip — NOT recommended): " API_TOKEN
    fi

    node -e "
      const fs = require('fs'), p = './config.json';
      const c  = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
      c.bindHost = '0.0.0.0';
      const tok = process.argv[2];
      if (tok) c.apiToken = tok;
      fs.writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
    " -- "$API_TOKEN"
    chmod 600 config.json 2>/dev/null || true

    ok "bindHost set to 0.0.0.0"
    [[ -z "$API_TOKEN" ]] && warn "No API token set — the GUI is open to the internet without auth!"
else
    ok "GUI will bind to localhost (127.0.0.1)"
    info "Remote access via SSH tunnel: ssh -L 3000:localhost:3000 user@<server>"
fi

# ── 10. PM2 process manager (optional) ───────────────────────────────────────
step "10. Process manager (PM2)..."

SETUP_PM2="n"
PM2_ACTIVE=false

if [[ -t 0 ]]; then
    echo ""
    echo -e "  PM2 keeps the server alive after logout and restarts it on crash."
    read -rp "  Install PM2 and start now? [y/N]: " SETUP_PM2
fi

if [[ "$SETUP_PM2" =~ ^[Yy]$ ]]; then
    info "Installing PM2 globally..."
    npm install -g pm2 2>&1 | tail -3

    info "Starting vps-sender via PM2..."
    pm2 start ecosystem.config.js

    info "Saving PM2 process list..."
    pm2 save

    info "Configuring PM2 to start on system boot..."
    if [[ "$OS" == "linux" ]]; then
        STARTUP_CMD=$(pm2 startup 2>&1 | grep -E "sudo env PATH|sudo.*pm2" | tail -1 || true)
        if [[ -n "$STARTUP_CMD" ]]; then
            info "Running: $STARTUP_CMD"
            eval "$STARTUP_CMD" 2>/dev/null || \
                warn "Could not set startup hook automatically. Run manually: $STARTUP_CMD"
        fi
    elif [[ "$OS" == "mac" ]]; then
        pm2 startup launchd 2>/dev/null || \
            warn "Run 'pm2 startup launchd' manually and follow the instructions."
    fi

    ok "PM2 running — commands: pm2 status | pm2 logs vps-sender | pm2 restart vps-sender"
    PM2_ACTIVE=true
else
    ok "Skipped PM2 — start manually with: npm start"
fi

# ── 11. Local MTA relay (Postfix) — Linux only, optional ─────────────────────
if [[ "$OS" == "linux" ]]; then
    step "11. Local MTA relay (Postfix)..."

    SETUP_POSTFIX="n"
    if [[ -t 0 ]]; then
        echo ""
        echo -e "  A local Postfix relay improves deliverability: the app hands mail to"
        echo -e "  Postfix on ${BOLD}127.0.0.1:25${RESET} and Postfix handles outbound queuing, retries,"
        echo -e "  and bounce handling. Useful when port 25 is open on this server."
        echo ""
        read -rp "  Install and configure Postfix as a local relay? [y/N]: " SETUP_POSTFIX
    fi

    if [[ "$SETUP_POSTFIX" =~ ^[Yy]$ ]]; then
        RELAY_DOMAIN=""
        if [[ -t 0 ]]; then
            echo ""
            read -rp "  Enter your sending domain (e.g. mail.example.com): " RELAY_DOMAIN
        fi
        RELAY_DOMAIN="${RELAY_DOMAIN:-mail.localhost}"

        info "Installing Postfix..."
        if [[ "$PKG" == "apt" ]]; then
            DEBIAN_FRONTEND=noninteractive apt-get install -y postfix 2>&1 | tail -5
        elif [[ "$PKG" == "dnf" ]]; then
            run dnf install -y postfix 2>&1 | tail -5
        elif [[ "$PKG" == "yum" ]]; then
            run yum install -y postfix 2>&1 | tail -5
        else
            warn "Cannot auto-install Postfix — install it manually and re-run."
        fi

        info "Configuring Postfix as loopback-only relay for ${RELAY_DOMAIN}..."
        postconf -e "inet_interfaces = loopback-only"
        postconf -e "inet_protocols = ipv4"
        postconf -e "mynetworks = 127.0.0.0/8"
        postconf -e "myhostname = ${RELAY_DOMAIN}"
        postconf -e "mydomain = ${RELAY_DOMAIN#*.}"
        postconf -e "myorigin = \$mydomain"
        postconf -e "relayhost ="
        postconf -e "smtpd_banner = \$myhostname ESMTP"
        postconf -e "smtpd_tls_security_level = may"
        postconf -e "smtp_tls_security_level = may"
        postconf -e "smtp_tls_note_starttls_offer = yes"

        # ── Enable submission port (587) in master.cf ─────────────────────
        info "Enabling submission port (587) in master.cf..."
        if ! grep -qE "^submission " /etc/postfix/master.cf 2>/dev/null; then
            cat >> /etc/postfix/master.cf << 'MASTEREOF'

# Submission (587) for vps-sender local relay — loopback only, no SASL needed
submission inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_tls_security_level=none
  -o smtpd_relay_restrictions=permit_mynetworks,reject
MASTEREOF
            ok "Submission (port 587) added to master.cf"
        else
            ok "Submission port already configured in master.cf"
        fi

        # ── Optional TLS cert + SMTPS (port 465) ──────────────────────────
        SETUP_CERT="n"
        if [[ -t 0 ]] && [[ "$RELAY_DOMAIN" != "mail.localhost" ]]; then
            echo ""
            echo -e "  A TLS certificate enables encrypted SMTPS (port 465) — optional."
            echo -e "  ${YELLOW}Port 80 must be open to the internet for Let's Encrypt HTTP-01 challenge.${RESET}"
            read -rp "  Get a free TLS certificate for ${RELAY_DOMAIN}? [y/N]: " SETUP_CERT
        fi

        CERT_PATH=""
        KEY_PATH=""

        if [[ "$SETUP_CERT" =~ ^[Yy]$ ]]; then
            info "Installing certbot..."
            if   [[ "$PKG" == "apt" ]]; then DEBIAN_FRONTEND=noninteractive apt-get install -y certbot 2>&1 | tail -3
            elif [[ "$PKG" == "dnf" ]]; then dnf install -y certbot 2>&1 | tail -3
            elif [[ "$PKG" == "yum" ]]; then yum install -y certbot 2>&1 | tail -3
            else warn "Cannot auto-install certbot — install it manually."; fi

            if command -v certbot &>/dev/null; then
                info "Requesting Let's Encrypt certificate for ${RELAY_DOMAIN}..."
                certbot certonly --standalone -d "${RELAY_DOMAIN}" \
                    --non-interactive --agree-tos \
                    -m "admin@${RELAY_DOMAIN#*.}" 2>&1 | tail -10 \
                    || warn "certbot failed — ensure port 80 is accessible and DNS points here"
                LIVE_DIR="/etc/letsencrypt/live/${RELAY_DOMAIN}"
                if [[ -f "${LIVE_DIR}/fullchain.pem" ]]; then
                    CERT_PATH="${LIVE_DIR}/fullchain.pem"
                    KEY_PATH="${LIVE_DIR}/privkey.pem"
                    ok "Certificate obtained: ${CERT_PATH}"
                else
                    warn "Certificate not found — SMTPS (465) will not be configured"
                fi
            else
                warn "certbot not available — skipping TLS setup"
            fi
        fi

        if [[ -n "$CERT_PATH" ]]; then
            postconf -e "smtpd_tls_cert_file = ${CERT_PATH}"
            postconf -e "smtpd_tls_key_file  = ${KEY_PATH}"
            postconf -e "smtpd_tls_security_level = may"
            if ! grep -qE "^smtps " /etc/postfix/master.cf 2>/dev/null; then
                cat >> /etc/postfix/master.cf << 'MASTEREOF'

# SMTPS (465) — TLS wrapper mode, loopback only
smtps     inet  n       -       y       -       -       smtpd
  -o syslog_name=postfix/smtps
  -o smtpd_tls_wrappermode=yes
  -o smtpd_relay_restrictions=permit_mynetworks,reject
MASTEREOF
            fi
            ok "SMTPS (port 465) enabled with TLS certificate"
        fi

        info "Enabling and restarting Postfix..."
        systemctl enable postfix  2>/dev/null || true
        systemctl restart postfix 2>/dev/null || \
            service postfix restart 2>/dev/null || \
            warn "Could not restart Postfix. Run: sudo systemctl restart postfix"

        info "Updating config.json for relay mode..."
        node -e "
          const fs = require('fs'), p = './config.json';
          const c  = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
          c.transport      = 'relay';
          c.relayHost      = '127.0.0.1';
          c.relayPort      = 587;
          c.relayUser      = '';
          c.relayPass      = '';
          c.envelopeDomain = process.argv[2];
          c.preScanRelay   = false;
          fs.writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
        " -- "$RELAY_DOMAIN"

        ok "Postfix installed — relay via 127.0.0.1:587 (submission) for ${RELAY_DOMAIN}"
        [[ -n "$CERT_PATH" ]] && ok "SMTPS port 465 also enabled with TLS"
        info "To verify Postfix is accepting mail locally:"
        echo -e "    ${CYAN}echo 'Test' | sendmail -v test@example.com${RESET}"
        info "Monitor the Postfix queue with: ${CYAN}mailq${RESET}  or  ${CYAN}postqueue -p${RESET}"
    else
        ok "Skipped Postfix — using direct-to-MX mode"
        info "You can switch to relay mode later in the Settings tab of the web GUI."
    fi
else
    step "11. Local MTA relay..."
    info "Postfix setup is Linux-only. On macOS, install Postfix manually or use"
    info "the Settings tab to configure an external relay (SMTP credentials)."
    ok "Skipped on non-Linux platform"
fi

# ── 12. Done ──────────────────────────────────────────────────────────────────

# Detect public IP (best-effort, silent on failure)
PUBLIC_IP=$(curl -fsSL --max-time 4 https://api.ipify.org 2>/dev/null \
            || curl -fsSL --max-time 4 https://ifconfig.me  2>/dev/null \
            || hostname -I 2>/dev/null | awk '{print $1}' \
            || echo "<your-server-ip>")

# Read bindHost and port back from config.json
BIND_HOST=$(node -e "try{const c=require('./config.json');process.stdout.write(c.bindHost||'127.0.0.1')}catch(e){process.stdout.write('127.0.0.1')}" 2>/dev/null || echo "127.0.0.1")
PORT_VAL=$(node  -e "try{const c=require('./config.json');process.stdout.write(String(c.port||3000))}catch(e){process.stdout.write('3000')}"       2>/dev/null || echo "3000")

if [[ "$BIND_HOST" == "0.0.0.0" ]]; then
    GUI_URL="http://${PUBLIC_IP}:${PORT_VAL}"
    SSH_HINT=""
else
    GUI_URL="http://localhost:${PORT_VAL}"
    SSH_HINT="  (remote: ssh -L ${PORT_VAL}:localhost:${PORT_VAL} user@<server>  then open localhost:${PORT_VAL})"
fi

echo ""
echo -e "${BOLD} ============================================================"
echo   "  Setup complete!"
echo   " ============================================================${RESET}"
echo ""
echo -e "  ${BOLD}Web GUI:${RESET}  ${GREEN}${GUI_URL}${RESET}"
[[ -n "$SSH_HINT" ]] && echo -e "  ${CYAN}${SSH_HINT}${RESET}"
echo ""
echo -e "  ${BOLD}NEXT STEPS:${RESET}"
echo ""
echo -e "  1. Edit ${CYAN}mxemails.txt${RESET}   — sender email addresses (or use the web GUI)"
echo -e "  2. Edit ${CYAN}recipients.txt${RESET} — destination addresses"
echo -e "  3. Edit ${CYAN}body.html${RESET}      — email body HTML"

if [[ "$PM2_ACTIVE" == "true" ]]; then
    echo -e "  4. Server is already running via PM2"
    echo -e "     ${GREEN}pm2 logs vps-sender${RESET}     — live logs"
    echo -e "     ${GREEN}pm2 restart vps-sender${RESET}  — restart after config change"
else
    echo -e "  4. Run: ${GREEN}npm start${RESET}           — starts the web GUI"
    echo -e "     Or:  ${GREEN}npm run cli${RESET}         — interactive CLI mode"
fi

echo ""
echo -e "  ${BOLD}Other commands:${RESET}"
echo -e "    ${GREEN}npm run generate-dkim${RESET}  — create DKIM keys for your domain"
echo -e "    ${GREEN}npm test${RESET}               — run tests"
echo ""

if [[ "$PORT25_OPEN" == "false" ]]; then
    echo -e "  ${YELLOW}Port 25 is blocked${RESET} — configure a SOCKS5 proxy in the"
    echo -e "  Settings tab before starting your first campaign."
    echo ""
fi

echo -e " ============================================================"
echo ""
