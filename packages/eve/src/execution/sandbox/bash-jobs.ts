import { createHash, randomUUID } from "node:crypto";

import { shellQuote } from "#execution/sandbox/shell-quote.js";

/** How long a `bash` call waits before it leaves the command running as a job. */
export const BASH_JOB_YIELD_SECONDS = 30;

/** The longest `eve-job wait` blocks, kept under the yield so a wait never becomes a job itself. */
export const BASH_JOB_MAX_WAIT_SECONDS = 25;

/** Where jobs, their output, and the `eve-job` helper live inside the sandbox. */
export const BASH_JOB_ROOT = "/tmp/.eve";

/** Unread bytes per stream that one observation transfers out of the sandbox. */
const BASH_JOB_OUTPUT_CAP_BYTES = 256 * 1024;

/** Seconds `eve-job stop` waits after SIGTERM before it sends SIGKILL. */
const BASH_JOB_STOP_GRACE_SECONDS = 5;

const HEADER_PREFIX = "eve-job:v1 ";
const UNSUPPORTED_MARKER = "eve-job:unsupported";

// The script is both the launcher every `bash` call runs and the `eve-job`
// helper the model runs to observe or stop a job. `run` installs it on PATH
// from `BASH_EXECUTION_STRING`, so the sandbox never needs a separate upload.
//
// Each job runs in its own process group so `stop` reaches its whole tree. The
// `exit` file is written by the job's wrapper after the command ends, which
// makes it the single completion signal for later observers.
const BASH_JOB_SCRIPT = `set -u
cap=${BASH_JOB_OUTPUT_CAP_BYTES}
max_wait=${BASH_JOB_MAX_WAIT_SECONDS}
stop_grace=${BASH_JOB_STOP_GRACE_SECONDS}

die() { printf 'eve-job: %s\\n' "$1" >&2; exit "\${2:-1}"; }

size_of() {
  [ -f "$1" ] || { echo 0; return; }
  local n
  n=$(wc -c < "$1")
  echo $((n + 0))
}

# Sets R_START, R_SIZE, and R_SKIP for the unread bytes of $1, capped at $cap.
unread_range() {
  local off
  off=$(cat "$1.off" 2>/dev/null) || off=0
  R_SIZE=$(size_of "$1")
  R_START=$((\${off:-0} + 0))
  R_SKIP=0
  [ "$R_START" -gt "$R_SIZE" ] && R_START=$R_SIZE
  if [ $((R_SIZE - R_START)) -gt "$cap" ]; then
    R_SKIP=$((R_SIZE - R_START - cap))
    R_START=$((R_SIZE - cap))
  fi
  return 0
}

# Writes bytes [$2, $3) of $1 to stdout and marks them read.
copy_range() {
  if [ "$3" -gt "$2" ]; then tail -c +$(($2 + 1)) "$1" | head -c $(($3 - $2)); fi
  printf '%s' "$3" > "$1.off"
}

# Whether process group $1 has a live member. Sandboxes often run without an
# init process, so exited jobs linger as zombies that kill -0 still reaches;
# /proc tells them apart.
group_alive() {
  local pgid=$1 stat fields
  if [ ! -d /proc/self ]; then
    kill -0 -- "-$pgid" 2>/dev/null
    return
  fi
  for stat in /proc/[0-9]*/stat; do
    read -r fields < "$stat" 2>/dev/null || continue
    # Fields after the command name: state, ppid, pgrp.
    set -- \${fields##*) }
    [ "$3" = "$pgid" ] && [ "$1" != Z ] && return 0
  done
  return 1
}

# Sets ST (running, exited, stopped, or lost) and CODE for the job in $1.
job_state() {
  CODE=
  if [ -f "$1/exit" ]; then
    CODE=$(cat "$1/exit")
    if [ -f "$1/stopped" ]; then ST=stopped; else ST=exited; fi
  elif [ ! -f "$1/pgid" ] || group_alive "$(cat "$1/pgid")"; then
    ST=running
  else
    ST=lost
  fi
}

job_dir() {
  case $1 in
    ''|*[!A-Za-z0-9_-]*) die "invalid job id: $1" 2 ;;
  esac
  [ -d "$root/jobs/$1" ] || die "no job named $1. Run \\"eve-job list\\" to see jobs."
  printf '%s' "$root/jobs/$1"
}

# Prints a job's unread output followed by one status line.
report() {
  local id=$1 dir=$2 os oz ok es ez ek
  # Read state before output: once the exit file exists, the output is complete.
  job_state "$dir"
  unread_range "$dir/stdout"; os=$R_START; oz=$R_SIZE; ok=$R_SKIP
  unread_range "$dir/stderr"; es=$R_START; ez=$R_SIZE; ek=$R_SKIP
  [ "$ok" -gt 0 ] && printf '[eve-job: %s earlier bytes of stdout omitted]\\n' "$ok"
  copy_range "$dir/stdout" "$os" "$oz"
  if [ "$oz" -gt "$os" ] && [ -n "$(tail -c 1 "$dir/stdout")" ]; then echo; fi
  {
    [ "$ek" -gt 0 ] && printf '[eve-job: %s earlier bytes of stderr omitted]\\n' "$ek"
    copy_range "$dir/stderr" "$es" "$ez"
  } >&2
  case $ST in
    running) printf '[eve-job %s: still running. Run "eve-job wait %s" to keep waiting or "eve-job stop %s" to stop it.]\\n' "$id" "$id" "$id" ;;
    exited) printf '[eve-job %s: exited with code %s]\\n' "$id" "$CODE" ;;
    stopped) printf '[eve-job %s: stopped (exit code %s)]\\n' "$id" "$CODE" ;;
    lost) printf '[eve-job %s: lost. The process ended without recording an exit code.]\\n' "$id" ;;
  esac
  if [ "$ST" != running ]; then
    rm -f "$dir/stdout" "$dir/stderr" "$dir/stdout.off" "$dir/stderr.off"
  fi
  return 0
}

cmd_wait() {
  local id=\${1:-} secs=\${2:-10} dir deadline
  dir=$(job_dir "$id") || exit
  case $secs in
    ''|*[!0-9]*) die "seconds must be a whole number" 2 ;;
  esac
  [ "$secs" -gt "$max_wait" ] && secs=$max_wait
  deadline=$((SECONDS + secs))
  job_state "$dir"
  while [ "$ST" = running ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.2
    job_state "$dir"
  done
  report "$id" "$dir"
}

cmd_stop() {
  local id=\${1:-} dir pgid i
  dir=$(job_dir "$id") || exit
  job_state "$dir"
  if [ "$ST" = running ] && [ -f "$dir/pgid" ]; then
    pgid=$(cat "$dir/pgid")
    : > "$dir/stopped"
    kill -TERM -- "-$pgid" 2>/dev/null
    i=0
    while group_alive "$pgid" && [ "$i" -lt $((stop_grace * 5)) ]; do
      sleep 0.2
      i=$((i + 1))
    done
    if group_alive "$pgid"; then
      kill -KILL -- "-$pgid" 2>/dev/null
      i=0
      while group_alive "$pgid" && [ "$i" -lt 10 ]; do
        sleep 0.2
        i=$((i + 1))
      done
    fi
    if [ ! -f "$dir/exit" ] && ! group_alive "$pgid"; then
      printf '137' > "$dir/exit"
    fi
  fi
  report "$id" "$dir"
}

cmd_list() {
  local dir id found=
  for dir in "$root"/jobs/*/; do
    [ -d "$dir" ] || continue
    dir=\${dir%/}
    id=\${dir##*/}
    # Skip the job this list command itself runs in.
    [ "$id" = "\${EVE_JOB_ID:-}" ] && continue
    found=1
    job_state "$dir"
    printf '%s\\t%s\\t%s\\n' "$id" "$ST\${CODE:+ ($CODE)}" "$(head -n 1 "$dir/command" 2>/dev/null | cut -c 1-80)"
  done
  [ -n "$found" ] || echo "eve-job: no jobs"
}

# Runs on TERM, INT, or HUP while cmd_run waits, before the job was reported.
abort_run() {
  local killer
  if [ -n "$pid" ]; then
    kill -TERM -- "-$pid" 2>/dev/null
    ( sleep "$stop_grace"; kill -KILL -- "-$pid" ) < /dev/null > /dev/null 2>&1 3>&- &
    killer=$!
    # Reap the job before removing its directory; its wrapper may still be writing there.
    wait "$pid" 2>/dev/null
    kill -KILL -- "-$pid" 2>/dev/null
    kill "$killer" 2>/dev/null
  fi
  [ -n "$timer" ] && kill -- "-$timer" 2>/dev/null
  rm -rf "$dir"
  exit 143
}

cmd_run() {
  local id=$1 yield=$2 cmd=$3 deadline
  dir="$root/jobs/$1"
  pid=
  timer=
  local os oz ok es ez ek state
  # Without a writable job root, the caller runs the command directly instead.
  { mkdir -p "$root/bin" "$root/jobs" &&
    printf '#!/usr/bin/env bash\\n%s\\n' "$BASH_EXECUTION_STRING" > "$root/bin/.eve-job.$$" &&
    chmod +x "$root/bin/.eve-job.$$" &&
    mv -f "$root/bin/.eve-job.$$" "$root/bin/eve-job"; } 2>/dev/null ||
    { echo ${UNSUPPORTED_MARKER}; exit 0; }
  # Job control reports finished and killed jobs on stderr, so the launcher's
  # stderr goes to /dev/null and the job's stderr is copied to the saved fd 3.
  exec 3>&2 2>/dev/null
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\\n' "$cmd" > "$dir/command"
    : > "$dir/stdout"
    : > "$dir/stderr"
    # A call aborted before it reports its job takes the job down with it.
    trap abort_run TERM INT HUP
    set -m
    (
      trap '' HUP
      trap : TERM INT
      bash -lc "export PATH=\\"$root/bin:\\$PATH\\" EVE_JOB_ID=$id
$cmd" < /dev/null > "$dir/stdout" 2> "$dir/stderr"
      printf '%s' "$?" > "$dir/exit.tmp" && mv -f "$dir/exit.tmp" "$dir/exit"
    ) < /dev/null > /dev/null 2>&1 3>&- &
    pid=$!
    printf '%s' "$pid" > "$dir/pgid"
    trap : USR1
    ( sleep "$yield"; kill -USR1 "$$" ) < /dev/null > /dev/null 2>&1 3>&- &
    timer=$!
    set +m
    wait "$pid" 2>/dev/null
    kill -- "-$timer" 2>/dev/null
    trap - TERM INT HUP USR1
  else
    # A retried call finds the job its earlier attempt started and keeps waiting on it.
    deadline=$((SECONDS + yield))
    job_state "$dir"
    while [ "$ST" = running ] && [ "$SECONDS" -lt "$deadline" ]; do
      sleep 0.2
      job_state "$dir"
    done
  fi
  job_state "$dir"
  state=$ST
  unread_range "$dir/stdout"; os=$R_START; oz=$R_SIZE; ok=$R_SKIP
  unread_range "$dir/stderr"; es=$R_START; ez=$R_SIZE; ek=$R_SKIP
  printf '${HEADER_PREFIX}%s %s %s %s\\n' "$state" "\${CODE:--}" "$ok" "$ek"
  copy_range "$dir/stdout" "$os" "$oz"
  copy_range "$dir/stderr" "$es" "$ez" >&3
  [ "$state" = running ] || rm -rf "$dir"
  exit 0
}

case \${1:-} in
  run) root=$2; shift 2; cmd_run "$@" ;;
  wait|stop|list) root=$(cd "$(dirname "$0")/.." && pwd); sub=$1; shift; "cmd_$sub" "$@" ;;
  *) die "usage: eve-job wait <job> [seconds] | eve-job stop <job> | eve-job list" 2 ;;
esac
`;

/** A short job id derived from the call's key, so a retried call reattaches to its job. */
export function createBashJobId(jobKey: string | undefined): string {
  const seed = jobKey === undefined || jobKey.length === 0 ? randomUUID() : jobKey;
  return `job-${createHash("sha256").update(seed).digest("hex").slice(0, 8)}`;
}

/**
 * The command a `bash` call sends to the sandbox. A sandbox without a real
 * process model (no `bash` binary or no `kill`, such as `just-bash`) or
 * without a writable job root prints the unsupported marker instead of
 * running anything, and the caller falls back to running the command
 * directly. Only a real `bash` parses the job script, so interpreters that
 * cannot parse it never see it.
 */
export function buildBashJobLaunchCommand(input: {
  readonly command: string;
  readonly jobId: string;
  readonly root: string;
  readonly yieldSeconds: number;
}): string {
  const args = [input.root, input.jobId, String(input.yieldSeconds), input.command]
    .map(shellQuote)
    .join(" ");
  return (
    `if command -v bash >/dev/null 2>&1 && kill -0 "$$" 2>/dev/null; then ` +
    `exec bash -c ${shellQuote(BASH_JOB_SCRIPT)} eve-job run ${args}; ` +
    `fi; echo ${UNSUPPORTED_MARKER}`
  );
}

export type BashJobLaunchOutput =
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "job";
      readonly state: "exited" | "lost" | "running" | "stopped";
      readonly exitCode: number | undefined;
      readonly stderr: string;
      readonly stderrSkippedBytes: number;
      readonly stdout: string;
      readonly stdoutSkippedBytes: number;
    };

const HEADER_PATTERN = /^eve-job:v1 (exited|lost|running|stopped) (-?\d+|-) (\d+) (\d+)$/;

/** Reads the launcher's header line; `undefined` means the launcher itself failed. */
export function parseBashJobLaunchOutput(output: {
  readonly stderr: string;
  readonly stdout: string;
}): BashJobLaunchOutput | undefined {
  if (output.stdout.trim() === UNSUPPORTED_MARKER) return { kind: "unsupported" };
  if (!output.stdout.startsWith(HEADER_PREFIX)) return undefined;
  const newline = output.stdout.indexOf("\n");
  const header = newline === -1 ? output.stdout : output.stdout.slice(0, newline);
  const match = HEADER_PATTERN.exec(header);
  if (match === null) return undefined;
  const [, state, code, stdoutSkipped, stderrSkipped] = match;
  return {
    kind: "job",
    state: state as "exited" | "lost" | "running" | "stopped",
    exitCode: code === "-" ? undefined : Number(code),
    stderr: output.stderr,
    stderrSkippedBytes: Number(stderrSkipped),
    stdout: newline === -1 ? "" : output.stdout.slice(newline + 1),
    stdoutSkippedBytes: Number(stdoutSkipped),
  };
}
