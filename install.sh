#!/usr/bin/env bash
set -euo pipefail

# VaultOps one-command installer
# Usage: curl -fsSL <url>/install.sh | bash
#   or:  ./install.sh [--global-only]
#
# After install: cd /path/to/repo && vaultops add

ORIGINAL_PWD="${PWD}"
INSTALL_DIR="${VAULTOPS_INSTALL_DIR:-$HOME/.vaultops}"
DIST_URL="${VAULTOPS_DIST_URL:-https://github.com/Louis-Wu-Sea/vaultops/releases/latest/download/vaultops.tar.gz}"
GLOBAL_ONLY=false
BREW_AVAILABLE=""  # cached after first check

# ── helpers ──────────────────────────────────────────────────────────────
_info() { echo "  ℹ  $*"; }
_ok()   { echo "  ✓  $*"; }
_warn() { echo "  ⚠  $*"; }
_err()  { echo ""; echo "  ✗  $*" >&2; }

ensure_brew() {
  if [[ "$BREW_AVAILABLE" == "true" ]]; then return 0; fi
  if [[ "$BREW_AVAILABLE" == "false" ]]; then return 1; fi
  if command -v brew >/dev/null 2>&1; then
    BREW_AVAILABLE="true"; return 0
  fi
  _info "Homebrew not found. Installing..."
  if /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)" || true
    _ok "Homebrew installed"
    BREW_AVAILABLE="true"; return 0
  else
    BREW_AVAILABLE="false"; return 1
  fi
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then return 0; fi
  if [[ "$OS_TYPE" == "Darwin" ]]; then
    _warn "Node.js not found. Installing via Homebrew..."
    if ensure_brew && brew install node@22 && brew link node@22 --force --overwrite 2>/dev/null; then
      _ok "Node.js $(node --version) installed"
      return 0
    fi
    _err "Could not install Node.js automatically."
    _err "Please install it manually (version 20+ required): https://nodejs.org"
    _err "Then re-run the installer."
    exit 1
  else
    _err "Node.js is required but was not found."
    _err "  Ubuntu/Debian:  sudo apt install nodejs npm"
    _err "  Fedora/RHEL:    sudo dnf install nodejs"
    _err "  Or download:    https://nodejs.org"
    exit 1
  fi
}

ensure_obsidian() {
  # macOS: check both /Applications and ~/Applications
  if [[ "$OS_TYPE" == "Darwin" ]]; then
    if ls /Applications/Obsidian.app >/dev/null 2>&1 || \
       ls "$HOME/Applications/Obsidian.app" >/dev/null 2>&1; then
      return 0
    fi
    _warn "Obsidian not found. Installing via Homebrew..."
    if ensure_brew && brew install --cask obsidian; then
      _ok "Obsidian installed"
      return 0
    fi
    _err "Could not install Obsidian automatically."
    _err "Please install it manually: https://obsidian.md"
    _err "VaultOps will still work — open Obsidian later and add vault: $HOME/.vaultops/vault"
    # Non-fatal: continue install without Obsidian
  else
    if command -v obsidian >/dev/null 2>&1; then return 0; fi
    echo ""
    echo "  ℹ  Install Obsidian for the best VaultOps experience: https://obsidian.md"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      echo "VaultOps installer — Claude Code plugin for Obsidian task management"
      echo ""
      echo "Usage: curl -fsSL https://raw.githubusercontent.com/Louis-Wu-Sea/vaultops/main/install.sh | bash"
      echo "   or: ./install.sh [--global-only]"
      echo ""
      echo "Options:"
      echo "  --global-only          Install CLI only, skip project setup"
      echo ""
      echo "Environment overrides:"
      echo "  VAULTOPS_INSTALL_DIR   Where to install (default: ~/.vaultops)"
      echo "  VAULTOPS_DIST_URL      Distribution archive URL"
      exit 0
      ;;
    --global-only) GLOBAL_ONLY=true; shift ;;
    *) shift ;;
  esac
done

# 0. Detect OS and ensure dependencies
OS_TYPE="$(uname -s)"
ensure_obsidian

# 1. Download or update runtime files
mkdir -p "$INSTALL_DIR"
if [[ -d "${INSTALL_DIR}/scripts" ]]; then
  echo "Updating VaultOps at ${INSTALL_DIR}..."
else
  echo "Installing VaultOps to ${INSTALL_DIR}..."
fi
TMP_TAR="$(mktemp "${TMPDIR:-/tmp}/vaultops-install-XXXXXX.tar.gz")"
chmod 600 "$TMP_TAR"
TMP_SUM="${TMP_TAR}.sha256"
trap 'rm -f "$TMP_TAR" "$TMP_SUM"' EXIT
curl -fsSL --output "$TMP_TAR" "$DIST_URL"
if curl -fsSL --output "$TMP_SUM" "${DIST_URL}.sha256" 2>/dev/null; then
  EXPECTED="$(awk '{print $1}' "$TMP_SUM")"
  ACTUAL="$(shasum -a 256 "$TMP_TAR" | awk '{print $1}')"
  if [[ "$EXPECTED" != "$ACTUAL" ]]; then
    _err "Checksum mismatch — download may be corrupted or tampered."
    _err "  expected: $EXPECTED"
    _err "  got:      $ACTUAL"
    exit 1
  fi
  _ok "Checksum verified"
else
  _warn "Checksum file not available — skipping verification"
fi
tar xz -C "$INSTALL_DIR" -f "$TMP_TAR"

# 2. Ensure runtime dependencies
ensure_node

VAULTOPS_INSTALL_DIR="$INSTALL_DIR" node "${INSTALL_DIR}/scripts/vault_cli.js" install --no-update

# 3. Set up Obsidian vault config
VAULT_ROOT="${HOME}/.vaultops/vault"
OBSIDIAN_DIR="${VAULT_ROOT}/.obsidian"
if [[ ! -d "$OBSIDIAN_DIR" ]]; then
  mkdir -p "$OBSIDIAN_DIR"
  # Create minimal Obsidian workspace config
  cat > "${OBSIDIAN_DIR}/app.json" << 'OBSIDIAN_APP'
{
  "showLineNumber": true,
  "strictLineBreaks": false,
  "readableLineLength": true,
  "showFrontmatter": true,
  "foldHeading": true,
  "foldIndent": true
}
OBSIDIAN_APP
  cat > "${OBSIDIAN_DIR}/appearance.json" << 'OBSIDIAN_THEME'
{
  "baseFontSize": 16,
  "accentColor": "#7C3AED",
  "theme": "obsidian"
}
OBSIDIAN_THEME
  echo "✓ Obsidian vault config created at ${VAULT_ROOT}"

  # Try to register vault in Obsidian's vault list (macOS only)
  if [[ "$OS_TYPE" == "Darwin" ]]; then
    OBSIDIAN_JSON="${HOME}/Library/Application Support/obsidian/obsidian.json"
    if [[ -f "$OBSIDIAN_JSON" ]]; then
      # Check if vault is already registered
      if ! grep -q "$VAULT_ROOT" "$OBSIDIAN_JSON" 2>/dev/null; then
        echo "Register VaultOps vault in Obsidian? [Y/n]"
        read -r REG_VAULT
        if [[ "${REG_VAULT:-Y}" =~ ^[Yy]$ ]]; then
          # Use node to safely modify JSON (vars passed via env, not shell interpolation)
          OBSIDIAN_JSON_PATH="$OBSIDIAN_JSON" VAULT_ROOT_PATH="$VAULT_ROOT" node -e "
            const fs = require('fs');
            const p = process.env.OBSIDIAN_JSON_PATH;
            const vaultPath = process.env.VAULT_ROOT_PATH;
            const d = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!d.vaults) d.vaults = {};
            const id = require('crypto').randomBytes(8).toString('hex');
            d.vaults[id] = { path: vaultPath, ts: Date.now() };
            fs.writeFileSync(p, JSON.stringify(d, null, 2));
          " 2>/dev/null && echo "✓ Vault registered in Obsidian" || echo "Could not register vault automatically. Open Obsidian and add ${VAULT_ROOT} manually."
        fi
      fi
    fi
  fi
fi

if [[ "$GLOBAL_ONLY" == "true" ]]; then
  echo ""
  echo "✓ VaultOps installed!"
  echo ""
  echo "Next: cd /path/to/repo && vaultops add"
  vaultops open 2>/dev/null || true
  exit 0
fi

# 3. If run from a project directory, set it up
if [[ -d "${ORIGINAL_PWD}/.git" ]] || [[ -f "${ORIGINAL_PWD}/package.json" ]]; then
  echo ""
  echo "Setting up VaultOps for: ${ORIGINAL_PWD}"
  VAULTOPS_INSTALL_DIR="$INSTALL_DIR" node "${INSTALL_DIR}/scripts/vault_cli.js" add "$ORIGINAL_PWD"
else
  echo ""
  echo "To set up a project: cd /path/to/repo && vaultops add"
fi

if [[ -d "${ORIGINAL_PWD}/.git" ]] || [[ -f "${ORIGINAL_PWD}/package.json" ]]; then
  echo ""
  echo "  Open Claude Code in this project and type: /vault:today"
else
  echo ""
  echo "  Next — run this in every project you want Claude to remember:"
  echo ""
  echo "    cd /path/to/your/repo"
  echo "    vaultops add"
  echo ""
  echo "  Without it, Claude has no memory for that project."
fi

# Open Obsidian
VAULTOPS_INSTALL_DIR="$INSTALL_DIR" node "${INSTALL_DIR}/scripts/vault_cli.js" open "$ORIGINAL_PWD" 2>/dev/null || true
