#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_PREFIX="[retaildaddy-azure-setup]"
NODE_MAJOR_REQUIRED="${NODE_MAJOR_REQUIRED:-20}"

log() {
  printf '%s %s\n' "$LOG_PREFIX" "$*"
}

warn() {
  printf '%s WARN: %s\n' "$LOG_PREFIX" "$*" >&2
}

die() {
  printf '%s ERROR: %s\n' "$LOG_PREFIX" "$*" >&2
  exit 1
}

if [[ "$(uname -s)" != "Linux" ]]; then
  die "This setup script is intended for Ubuntu Linux Azure VMs."
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    warn "Detected ${PRETTY_NAME:-Linux}. The script is tested for Ubuntu Azure VMs."
  fi
fi

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=()
else
  command -v sudo >/dev/null 2>&1 || die "sudo is required when the script is not run as root."
  SUDO=(sudo)
fi

run_as_root() {
  "${SUDO[@]}" "$@"
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    printf '0'
    return
  fi
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

install_base_packages() {
  log "Installing Ubuntu packages for browser automation, virtual display, audio, and media."
  run_as_root apt-get update
  run_as_root apt-get install -y \
    apt-transport-https \
    build-essential \
    ca-certificates \
    curl \
    dbus-x11 \
    ffmpeg \
    fonts-liberation \
    fonts-noto \
    fonts-noto-color-emoji \
    gnupg \
    libasound2-plugins \
    lsb-release \
    pulseaudio \
    pulseaudio-utils \
    software-properties-common \
    unzip \
    wget \
    x11-utils \
    x11-xserver-utils \
    xvfb
}

install_node_if_needed() {
  local current_major
  current_major="$(node_major)"

  if (( current_major >= NODE_MAJOR_REQUIRED )); then
    log "Node.js $(node --version) is already installed."
    return
  fi

  log "Installing Node.js ${NODE_MAJOR_REQUIRED}.x from NodeSource."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" -o /tmp/retaildaddy-nodesource-setup.sh
  run_as_root bash /tmp/retaildaddy-nodesource-setup.sh
  run_as_root apt-get install -y nodejs

  current_major="$(node_major)"
  if (( current_major < NODE_MAJOR_REQUIRED )); then
    die "Node.js ${NODE_MAJOR_REQUIRED}+ is required, but $(node --version 2>/dev/null || printf 'node is missing') was found."
  fi

  log "Installed Node.js $(node --version) and npm $(npm --version)."
}

install_google_chrome_if_supported() {
  if command -v google-chrome-stable >/dev/null 2>&1; then
    log "Google Chrome is already installed: $(google-chrome-stable --version)."
    return
  fi

  if command -v google-chrome >/dev/null 2>&1; then
    log "Google Chrome is already installed: $(google-chrome --version)."
    return
  fi

  if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
    log "Chromium is already installed."
    return
  fi

  local arch
  arch="$(dpkg --print-architecture)"
  if [[ "$arch" != "amd64" ]]; then
    warn "Skipping Google Chrome install on architecture '$arch'. Playwright Chromium will still be installed."
    return
  fi

  log "Installing Google Chrome stable."
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor \
    | run_as_root tee /usr/share/keyrings/google-linux-signing-keyring.gpg >/dev/null

  printf 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main\n' \
    | run_as_root tee /etc/apt/sources.list.d/google-chrome.list >/dev/null

  run_as_root apt-get update
  run_as_root apt-get install -y google-chrome-stable
  log "Installed $(google-chrome-stable --version)."
}

install_project_dependencies() {
  cd "$PROJECT_DIR"

  log "Installing Node dependencies in $PROJECT_DIR."
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi

  log "Installing Playwright Chromium system dependencies."
  if command -v npx >/dev/null 2>&1; then
    run_as_root env "PATH=$PATH" npx playwright install-deps chromium
  else
    die "npx was not found after Node.js installation."
  fi

  log "Installing Playwright Chromium browser for the current user."
  npx playwright install chromium
}

print_next_steps() {
  cat <<'EOF'

[retaildaddy-azure-setup] Setup complete.

Next steps:
  1. Create a .env file or export environment variables. Do not put secrets in scripts.
     Required:
       SARVAM_API_KEY=...
       PRODUCT_URL=https://your-saas.example.com
       GOOGLE_MEET_URL=https://meet.google.com/xxx-yyyy-zzz

  2. Authenticate Google once on the VM display:
       scripts/run-agent-azure.sh auth

  3. Run the Meet demo:
       scripts/run-agent-azure.sh launch "https://meet.google.com/xxx-yyyy-zzz"

Optional:
  scripts/run-agent-azure.sh demo uses GOOGLE_MEET_URL from .env.
  MEET_AUTO_PRESENT=true attempts Meet screen sharing automatically.
  DESKTOP_CAPTURE_SOURCE may need to be "Entire screen", "Screen 1", or another Chrome capture-source label.
EOF
}

main() {
  install_base_packages
  install_node_if_needed
  install_google_chrome_if_supported
  install_project_dependencies
  print_next_steps
}

main "$@"
