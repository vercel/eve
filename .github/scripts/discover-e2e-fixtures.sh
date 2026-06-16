#!/usr/bin/env bash
# Discover e2e fixture directories for the CI matrix.
#
# A fixture qualifies when it has an `evals/` directory under one of the
# fixture roots. Emits a JSON array of `{ name, dir }` objects (sorted by dir)
# to the `matrix` GitHub Actions output for `matrix.include`.
set -euo pipefail

roots=("e2e/fixtures" "apps/fixtures")

entries=()
while IFS= read -r evals_dir; do
  dir="${evals_dir%/evals}"
  name="$(basename "$dir")"
  entries+=("{\"name\":\"${name}\",\"dir\":\"${dir}\"}")
done < <(
  for root in "${roots[@]}"; do
    [ -d "$root" ] || continue
    find "$root" -mindepth 2 -maxdepth 2 -type d -name evals
  done | sort
)

if [ "${#entries[@]}" -eq 0 ]; then
  echo "No e2e fixtures with an evals/ directory were found." >&2
  exit 1
fi

matrix="[$(
  IFS=,
  echo "${entries[*]}"
)]"

echo "Discovered fixtures: ${matrix}"
echo "matrix=${matrix}" >>"${GITHUB_OUTPUT:-/dev/stdout}"
