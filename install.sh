#!/usr/bin/env bash
#
# AI Voice Desk installer for Ubuntu, Debian and Raspberry Pi OS.
#
#   ./install.sh                 # install deps, init config, ask about service
#   ./install.sh --service       # also install + start the systemd user service
#   ./install.sh --no-service    # never touch systemd
#   ./install.sh --yes           # assume "yes" to prompts (non-interactive)
#
# The script is safe to re-run: it never overwrites an existing .env,
# data/settings.json or data/secrets.json.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
MIN_NODE="22.5.0"

INSTALL_SERVICE="ask"
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --service) INSTALL_SERVICE="yes" ;;
    --no-service) INSTALL_SERVICE="no" ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ -t 1 ]; then
  C_RESET="\033[0m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_BOLD="\033[1m"
else
  C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""
fi

info()  { printf "${C_GREEN}==>${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_YELLOW}==> %s${C_RESET}\n" "$*"; }
error() { printf "${C_RED}==> %s${C_RESET}\n" "$*" >&2; }
die()   { error "$*"; exit 1; }

confirm() {
  local prompt="$1"
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  read -r -p "$prompt [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

version_ge() {
  # returns 0 if $1 >= $2 (semver-ish)
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# ---------------------------------------------------------------------------
# 1. Platform detection
# ---------------------------------------------------------------------------
ARCH="$(uname -m)"
OS_NAME="unknown"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-$ID}")"
fi

info "AI Voice Desk installer"
info "OS:   ${OS_NAME}"
info "Arch: ${ARCH}"
case "$ARCH" in
  aarch64|arm64) info "Detected ARM64 (Raspberry Pi 5 / 64-bit ARM)." ;;
  armv7l|armv6l) warn "32-bit ARM detected. Node.js 22+ may not be available; 64-bit OS is recommended." ;;
  x86_64) ;;
  *) warn "Untested architecture '${ARCH}'; continuing anyway." ;;
esac

# ---------------------------------------------------------------------------
# 2. Node.js check
# ---------------------------------------------------------------------------
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -p 'process.versions.node')"
  info "Found Node.js ${NODE_VERSION}"
  if version_ge "$NODE_VERSION" "$MIN_NODE"; then
    NODE_OK=1
  else
    warn "Node.js ${NODE_VERSION} is older than the required ${MIN_NODE}."
  fi
else
  warn "Node.js was not found."
fi

if [ "$NODE_OK" -ne 1 ]; then
  if confirm "Install Node.js 22.x from NodeSource now (requires sudo)?"; then
    if ! command -v curl >/dev/null 2>&1; then
      sudo apt-get update
      sudo apt-get install -y curl ca-certificates
    fi
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    NODE_VERSION="$(node -p 'process.versions.node')"
    info "Installed Node.js ${NODE_VERSION}"
    version_ge "$NODE_VERSION" "$MIN_NODE" || die "Installed Node.js is still too old."
  else
    die "Node.js >= ${MIN_NODE} is required. Install it and re-run this script."
  fi
fi

if ! command -v npm >/dev/null 2>&1; then
  die "npm was not found. Reinstall Node.js (which bundles npm)."
fi

# ---------------------------------------------------------------------------
# 3. Dependencies
# ---------------------------------------------------------------------------
cd "$PROJECT_DIR"
if [ -f package-lock.json ]; then
  info "Installing dependencies (npm ci)..."
  npm ci --omit=dev
else
  info "Installing dependencies (npm install)..."
  npm install --omit=dev
fi

# ---------------------------------------------------------------------------
# 4. Directories + configuration
# ---------------------------------------------------------------------------
mkdir -p "$PROJECT_DIR/data" "$PROJECT_DIR/logs"
chmod 700 "$PROJECT_DIR/data" 2>/dev/null || true

if [ ! -f "$PROJECT_DIR/.env" ]; then
  if [ -f "$PROJECT_DIR/.env.example" ]; then
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    chmod 600 "$PROJECT_DIR/.env"
    info "Created .env from .env.example (edit it to set your AI endpoint)."
  else
    warn ".env.example is missing; skipping .env creation."
  fi
else
  info ".env already exists - leaving it untouched."
fi

# ---------------------------------------------------------------------------
# 5. Database initialisation
# ---------------------------------------------------------------------------
info "Initialising the database..."
run_init() {
  node "$@" -e "require('./config').init(); const db = require('./database'); db.init(); console.log('database ready');" 
}
if ! run_init 2>/dev/null; then
  run_init --experimental-sqlite
fi

# ---------------------------------------------------------------------------
# 6. systemd user service (optional)
# ---------------------------------------------------------------------------
if [ "$INSTALL_SERVICE" = "ask" ]; then
  if confirm "Install and start AI Voice Desk as a systemd user service?"; then
    INSTALL_SERVICE="yes"
  else
    INSTALL_SERVICE="no"
  fi
fi

if [ "$INSTALL_SERVICE" = "yes" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    node "$PROJECT_DIR/scripts/service.js" install
  else
    warn "systemctl not found; skipping service installation."
  fi
fi

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------
PORT="$(grep -E '^PORT=' "$PROJECT_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2 || true)"
PORT="${PORT:-8381}"

printf "\n${C_BOLD}Installation complete.${C_RESET}\n\n"
echo "  Project:   ${PROJECT_DIR}"
echo "  Config:    ${PROJECT_DIR}/.env  (edit AI_BASE_URL, AI_MODEL, AI_API_KEY)"
echo "  URL:       http://127.0.0.1:${PORT}"
echo
echo "  Start:     npm start"
echo "  Dev:       npm run dev"
echo "  Stop:      Ctrl+C (or: systemctl --user stop ai-voice-desk)"
echo "  Restart:   npm run service:restart  (service) or Ctrl+C then npm start"
echo "  Logs:      npm run service:logs     (service)"
echo "  Test:      npm test"
echo
echo "  First run: open the URL, click Settings, and set your AI endpoint,"
echo "             model and API key. Nothing is sent anywhere until you do."
echo
echo "  Note: microphone access requires HTTPS or http://localhost."
echo "        For LAN access set LAN_ACCESS=true and AUTH_PASSWORD in .env,"
echo "        and serve over HTTPS (see README.md)."
echo
