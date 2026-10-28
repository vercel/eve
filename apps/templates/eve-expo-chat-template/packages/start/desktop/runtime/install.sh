#!/usr/bin/env bash
set -euo pipefail
cd /tmp/eve
if ! command -v google-chrome >/dev/null || ! command -v x11vnc >/dev/null; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb x11vnc openbox fonts-liberation curl ca-certificates
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/eve-chrome.deb
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/eve-chrome.deb
  unlink /tmp/eve-chrome.deb
fi
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /data/chrome-profile
npm install --omit=dev --ignore-scripts --no-audit --no-fund

node node_modules/agent-browser/scripts/postinstall.js

if [ -f browser.mjs ]; then unlink browser.mjs; fi
