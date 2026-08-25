#!/usr/bin/env bash
set -euo pipefail

RUNS="${RUNS:-3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/eve-promise-without-action.XXXXXX")"

cleanup() {
  if [[ "${KEEP_REPRO:-0}" == "1" ]]; then
    printf 'Retained repro app: %s\n' "$WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$WORK_DIR/agent/tools" "$WORK_DIR/evals"

cat > "$WORK_DIR/package.json" <<'JSON'
{
  "name": "eve-promise-without-action-repro",
  "private": true,
  "type": "module",
  "dependencies": {
    "eve": "0.39.1",
    "zod": "^4.0.0"
  }
}
JSON

cat > "$WORK_DIR/agent/agent.ts" <<'TS'
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
});
TS

cat > "$WORK_DIR/agent/instructions.md" <<'MD'
# Change-plan agent

You help users prepare changes. A revised target requires emitting a revised
plan.

Narration is not completion. If you say you will revise or submit a plan, call
the tool in the same response.
MD

cat > "$WORK_DIR/agent/tools/request-change-confirmation.ts" <<'TS'
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

const gated = process.env.REPRO_APPROVAL_MODE === "gated";

export default defineTool({
  description: "Present an initial change plan for requester confirmation.",
  inputSchema: z.object({ targetUserId: z.string() }),
  ...(gated ? { approval: always() } : {}),
  async execute(input) {
    return { pendingRequesterConfirmation: true, ...input };
  },
});
TS

cat > "$WORK_DIR/agent/tools/emit-revised-change-plan.ts" <<'TS'
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Emit a revised change plan when the user corrects its target.",
  inputSchema: z.object({ targetUserId: z.string() }),
  async execute(input) {
    return { emitted: true, ...input };
  },
});
TS

cat > "$WORK_DIR/evals/evals.config.ts" <<'TS'
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  maxConcurrency: 1,
  timeoutMs: 180_000,
});
TS

cat > "$WORK_DIR/evals/promise-without-action.eval.ts" <<'TS'
import { defineEval } from "eve/evals";

const INITIAL_TARGET = "005INITIALTARGET";
const CORRECTED_TARGET = "005CORRECTEDTARGET";
const gated = process.env.REPRO_APPROVAL_MODE === "gated";

export default defineEval({
  async test(t) {
    const initial = await t.send(
      `Present a change plan targeting user id ${INITIAL_TARGET} by calling request-change-confirmation.`,
    );

    initial.calledTool("request-change-confirmation", {
      ...(gated
        ? { status: "pending" as const }
        : { output: { pendingRequesterConfirmation: true } }),
      input: { targetUserId: INITIAL_TARGET },
      count: 1,
    });

    const corrected = await t.send(
      [
        "I am the original requester and confirm the intended outcome:",
        `set the target to explicit user id ${CORRECTED_TARGET}, not ${INITIAL_TARGET}.`,
        "The correction is authorized. Please revise and submit the plan now.",
      ].join("\n"),
    );

    corrected.expectOk();
    corrected.messageIncludes(/revis|submit/iu);
    corrected.calledTool("emit-revised-change-plan", {
      input: { targetUserId: CORRECTED_TARGET },
      count: 1,
    });
  },
});
TS

cd "$WORK_DIR"
printf 'Installing isolated eve@0.39.1 fixture in %s\n' "$WORK_DIR"
pnpm install --ignore-workspace --config.ignore-workspace=true >/dev/null

run_variant() {
  local mode="$1"
  local expect="$2"
  local run

  for ((run = 1; run <= RUNS; run += 1)); do
    printf '\n=== %s run %d/%d ===\n' "$mode" "$run" "$RUNS"
    if REPRO_APPROVAL_MODE="$mode" pnpm exec eve eval promise-without-action \
      --strict --skip-report; then
      if [[ "$expect" == "failure" ]]; then
        printf 'ERROR: approval-gated variant unexpectedly passed.\n' >&2
        return 1
      fi
    else
      if [[ "$expect" == "success" ]]; then
        printf 'ERROR: ungated control unexpectedly failed.\n' >&2
        return 1
      fi
    fi
  done
}

run_variant gated failure
run_variant ungated success

printf '\nReproduced the historical failure and passed the ungated control.\n'
printf 'Source artifact: %s\n' "$ROOT"
