#!/bin/sh
# Builds a folder of the step demos, ready to zip: eve's staged package packed as a tarball,
# the step folders with each package.json pointing `eve` at it and `ai` at the version eve is built
# with, and the walkthrough README. Build eve first (`pnpm run build` in packages/eve).
#   demo/steps/bundle.sh [outdir]      (default /tmp/eve-steps)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
eve="$here/../.."
out="${1:-/tmp/eve-steps}"
version="$(node -p "require('$eve/package.json').version")"
ai="$(node -p "require('$eve/node_modules/ai/package.json').version")"

rm -rf "$out" && mkdir -p "$out"
(cd "$eve/.package" && npm pack --silent --pack-destination "$out" >/dev/null)
for step in 1-script 2-tui 3-webpage; do
  tar -C "$here" --exclude=node_modules --exclude=dist -cf - "$step" | tar -C "$out" -xf -
  node -e '
    const [file, tarball, ai] = process.argv.slice(1);
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.dependencies = { ...manifest.dependencies, ai, eve: `file:../${tarball}` };
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$out/$step/package.json" "eve-$version.tgz" "$ai"
done
cp "$here/README.md" "$out/README.md"
echo "$out: eve-$version.tgz, 1-script, 2-tui, 3-webpage, README.md (ai $ai)"
