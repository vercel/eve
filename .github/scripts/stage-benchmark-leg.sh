#!/usr/bin/env bash
# Stages one eval-benchmark leg for upload as $RUNNER_TEMP/leg:
#   meta.json      leg identity and runner context
#   expected.json  `eve eval --list --json` output, when the run got that far
#   run/           the leg's single `.eve/evals/<timestamp>` tree, when one exists
# The publish job (scripts/eval-benchmark/records.mjs) reads this layout.
set -euo pipefail

leg="$RUNNER_TEMP/leg"
rm -rf "$leg"
mkdir -p "$leg"

jq -n \
  --arg leg_id "$LEG_ID" \
  --arg sha "$PLANNED_SHA" \
  --arg model_id "$MODEL_ID" \
  --arg world "$WORLD" \
  --argjson attempt "$ATTEMPT" \
  --arg runner_os "$RUNNER_OS_NAME" \
  '{leg_id: $leg_id, sha: $sha, model_id: $model_id, world: $world, attempt: $attempt, runner_os: $runner_os}' \
  >"$leg/meta.json"

if [ -s "$RUNNER_TEMP/expected.json" ]; then
  cp "$RUNNER_TEMP/expected.json" "$leg/expected.json"
fi

shopt -s nullglob
runs=("$FIXTURE_DIR"/.eve/evals/*/)
if [ "${#runs[@]}" -gt 1 ]; then
  echo "::error::Expected one .eve/evals tree in $FIXTURE_DIR, found ${#runs[@]}."
  exit 1
fi
if [ "${#runs[@]}" -eq 1 ]; then
  cp -R "${runs[0]}" "$leg/run"
fi
