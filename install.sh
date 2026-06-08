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

# ── 8. Firewall note (Linux only) ────────────────────────────────────────────
if [[ "$OS" == "linux" ]]; then
    if command -v ufw &>/dev/null; then
        UFW_STATUS=$(ufw status 2>/dev/null | head -1 || true)
        if echo "$UFW_STATUS" | grep -q "active"; then
            info "UFW firewall is active."
            info "The Web GUI runs on port 3000 (localhost only by default)."
            info "To expose it on the network: sudo ufw allow 3000"
        fi
    fi
fi

# ── 9. Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD} ============================================================"
echo   "  Setup complete!"
echo   " ============================================================${RESET}"
echo ""
echo -e "  ${BOLD}NEXT STEPS:${RESET}"
echo ""
echo -e "  1. Edit ${CYAN}mxemails.txt${RESET}   — add your sender email addresses"
echo -e "  2. Edit ${CYAN}recipients.txt${RESET} — add destination email addresses"
echo -e "  3. Edit ${CYAN}body.html${RESET}      — customise your email content"
echo -e "  4. Run:  ${GREEN}npm start${RESET}      — opens Web GUI at http://localhost:3000"
echo ""
echo -e "  ${BOLD}Other commands:${RESET}"
echo -e "    ${GREEN}npm run cli${RESET}              — interactive command-line mode"
echo -e "    ${GREEN}npm run generate-dkim${RESET}    — create DKIM keys for your domain"
echo -e "    ${GREEN}npm test${RESET}                 — run tests"
echo ""

if [[ "$PORT25_OPEN" == "false" ]]; then
    echo -e "  ${YELLOW}Port 25 is blocked${RESET} — configure a SOCKS5 proxy in the"
    echo -e "  Settings tab before starting your first campaign."
    echo ""
fi

echo -e " ============================================================"
echo ""
