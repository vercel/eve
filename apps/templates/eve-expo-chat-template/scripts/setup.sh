#!/usr/bin/env bash
# Standalone Expo template setup. Uses your own Vercel project; no relay registration.
set -euo pipefail
cd "$(dirname "$0")/.."
for cmd in node pnpm vercel; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd"; exit 1; }
done
node --input-type=module -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 3)) { console.error("Node.js 24.3+ is required"); process.exit(1); }'
# Install and build the local implementation packages before provisioning.
pnpm install --frozen-lockfile
if [ ! -f .vercel/project.json ]; then
  vercel link "$@"
fi
node --conditions=development scripts/setup.ts "$@"
