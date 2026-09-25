#!/usr/bin/env bash
# Reproduce a TUI that follows background work after its foreground turn ended.
#
# Run this from the repository root:
#   e2e/fixtures/fixture-tasks/scripts/reproduce-tui-idle-work.sh
#
# In the TUI, send TUI-IDLE-WORK-REPRO. The parent reports
# TUI-IDLE-WORK-STARTED and returns to its prompt; its background task then
# durably waits 20 seconds before asking for first_gate, second_gate, and
# third_gate approvals.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
port="${EVE_TUI_REPRO_PORT:-3217}"
log_file="${TMPDIR:-/tmp}/eve-tui-idle-work-${port}.log"

cleanup() {
  if [[ -n "${server_pid:-}" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

cd "$repo_root"
EVE_E2E_MODEL=mock pnpm --filter fixture-tasks exec eve dev --no-ui --port "$port" >"$log_file" 2>&1 &
server_pid=$!

until curl --silent --fail --max-time 1 "http://127.0.0.1:${port}/eve/v1/health" >/dev/null; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$log_file" >&2
    exit 1
  fi
  sleep 0.2
done

printf 'Fixture server: http://127.0.0.1:%s\nServer log: %s\n\n' "$port" "$log_file"
cat <<'EOF'
Background idle-follow repro:
  TUI-IDLE-WORK-REPRO
    Returns to the prompt, then waits 20 seconds before requesting approval.

Foreground hang lab (each holds for 45 seconds):
  TUI-HANG-IN-PROCESS  ordinary Node.js promise timer
  TUI-HANG-WORKFLOW    durable workflow sleep
  TUI-HANG-COMMAND     child process: sleep 45 (logs start/completion)
  TUI-HANG-SUBAGENT    foreground subagent whose own tool waits
EOF
printf '\n'

pnpm --filter fixture-tasks exec eve remote connect "http://127.0.0.1:${port}"
