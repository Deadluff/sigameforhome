#!/usr/bin/env bash
# ==========================================================================
#  SIGame Local - one-click / fast-start launcher for macOS (and Linux)
#  - double-click "start.command" in Finder, or run "./start.sh" in Terminal
#  - checks Node.js (looks in Homebrew / nvm / fnm / Volta paths too)
#  - installs dependencies on first run or when package.json changes
#  - generates sample packs if packs/ is empty
#  - starts the server and displays the LAN link + QR code
#  Optional: PORT=3001 ./start.sh to use another port.
# ==========================================================================

set -u

# Always run from the project root where this script lives
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# Finder launches .command files with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
# Add common macOS Node.js locations (Apple Silicon Homebrew, Intel Homebrew, nvm, fnm, Volta).
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/current/bin:$HOME/.volta/bin:$HOME/.fnm/current/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ] && ! command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

pause_if_finder() {
  # Keep the Terminal window open when launched by double-clicking in Finder
  if [[ "$0" == *.command ]]; then
    echo ""
    read -r -p "  Press Enter to close this window..." _
  fi
}

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  [!] Node.js was not found."
  echo "      Install Node.js 18+ LTS from https://nodejs.org"
  echo "      or via Homebrew:  brew install node"
  pause_if_finder
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo ""
  echo "  [!] Node.js 18 or newer is required. You have: $(node -v)"
  echo "      Update from https://nodejs.org or via: brew upgrade node"
  pause_if_finder
  exit 1
fi

# Install dependencies if node_modules is missing or older than package.json
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
  echo "  Installing dependencies, please wait..."
  if ! npm install --omit=dev --no-audit --no-fund; then
    echo "  [!] npm install failed. Check your internet connection."
    pause_if_finder
    exit 1
  fi
  touch "node_modules"
fi

mkdir -p packs

# Create demo packs if the packs folder has no .siq files yet
if ! ls packs/*.siq >/dev/null 2>&1; then
  echo "  Creating sample packs in packs/..."
  npx --no-install tsx scripts/make-sample-pack.ts
fi

npx --no-install tsx server/index.ts
echo ""
echo "  Server stopped."
pause_if_finder
