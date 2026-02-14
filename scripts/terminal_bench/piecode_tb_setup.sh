#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates

# Install Node.js via nvm (matches terminal-bench installed-agent patterns).
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
fi
source "$NVM_DIR/nvm.sh"
nvm install 22
nvm use 22

cd /installed-agent/piecode
npm install --omit=dev --no-audit --no-fund
