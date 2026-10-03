import { createHash, randomUUID } from "node:crypto";

import { shellQuote } from "#execution/sandbox/shell-quote.js";

/** How long a `bash` call waits before it leaves the command running as a job. */
export const BASH_JOB_YIELD_SECONDS = 30;

/** The longest `eve-job wait` blocks, kept under the yield so a wait never becomes a job itself. */
export const BASH_JOB_MAX_WAIT_SECONDS = 25;

/** Where jobs, their output, and the `eve-job` helper live inside the sandbox. */
export const BASH_JOB_ROOT = "/tmp/.eve";

/**
 * Unread bytes per stream that one launch transfers out of the sandbox. The
 * `bash` tool keeps at most 50 KiB of each stream, so more would be dropped.
 */
const BASH_JOB_OUTPUT_CAP_BYTES = 64 * 1024;

/** Seconds `eve-job stop` waits after SIGTERM before it sends SIGKILL. */
const BASH_JOB_STOP_GRACE_SECONDS = 5;

// The script is both the launcher every `bash` call runs and the `eve-job`
// helper the model runs to observe or stop a job. The launcher installs it on
// PATH from `BASH_EXECUTION_STRING`, so the sandbox never needs an upload.
//
// Each job runs in its own process group so `stop` reaches its whole tree. The
// job's wrapper writes the `exit` file after the command ends, which makes it
// the single completion signal for later observers. A job directory is
// removed once its final state has been reported.
const BASH_JOB_SCRIPT = `set -u
cap=${BASH_JOB_OUTPUT_CAP_BYTES}
# eve-job output passes through a launcher, so it leaves room for the launcher's cap.
report_cap=$((cap - 1024))
max_wait=${BASH_JOB_MAX_WAIT_SECONDS}
stop_grace=${BASH_JOB_STOP_GRACE_SECONDS}

die() { printf 'eve-job: %s\\n' "$1" >&2; exit "\${2:-1}"; }

size_of() {
  [ -f "$1" ] || { echo 0; return; }
  local n
  n=$(wc -c < "$1")
  echo $((n + 0))
}

# Sets R_START, R_SIZE, and R_SKIP for the unread bytes of $1, capped at $2.
unread_range() {
  local off
  off=$(cat "$1.off" 2>/dev/null) || off=0
  R_SIZE=$(size_of "$1")
  R_START=$((\${off:-0} + 0))
  R_SKIP=0
  [ "$R_START" -gt "$R_SIZE" ] && R_START=$R_SIZE
  if [ $((R_SIZE - R_START)) -gt "$2" ]; then
    R_SKIP=$((R_SIZE - R_START - $2))
    R_START=$((R_SIZE - $2))
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
    { read -r fields < "$stat"; } 2>/dev/null || continue
    # Fields after the command name: state, ppid, pgrp.
    set -- \${fields##*) }
    [ "$3" = "$pgid" ] && [ "$1" != Z ] && return 0
  done
  return 1
}

# Sets ST (running, exited, stopped, or lost) and CODE for the job in $1.
job_state() {
  CODE=
  if [ ! -d "$1" ]; then
    ST=lost
  elif [ -f "$1/exit" ]; then
    CODE=$(cat "$1/exit")
    if [ -f "$1/stopped" ]; then ST=stopped; else ST=exited; fi
  elif [ ! -f "$1/pgid" ] || group_alive "$(cat "$1/pgid")"; then
    ST=running
  else
    ST=lost
  fi
}

# Polls the job in $1 until it stops running or $2 seconds pass.
wait_while_running() {
  local deadline=$((SECONDS + $2))
  job_state "$1"
  while [ "$ST" = running ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.2
    job_state "$1"
  done
}

job_dir() {
  case $1 in
    ''|*[!A-Za-z0-9_-]*) die "invalid job id: $1" 2 ;;
  esac
  [ -d "$root/jobs/$1" ] ||
    die "no job named $1. A finished job is removed after its final status is reported; run \\"eve-job list\\" to see jobs."
  printf '%s' "$root/jobs/$1"
}

# Prints a job's unread output and one status line, then exits with the job's
# exit code if it exited, 1 if it was lost, and 0 otherwise.
report() {
  local id=$1 dir=$2 os oz ok es ez ek
  # Read state before output: once the exit file exists, the output is complete.
  job_state "$dir"
  unread_range "$dir/stdout" "$report_cap"; os=$R_START; oz=$R_SIZE; ok=$R_SKIP
  unread_range "$dir/stderr" "$report_cap"; es=$R_START; ez=$R_SIZE; ek=$R_SKIP
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
  [ "$ST" = running ] && exit 0
  rm -rf "$dir"
  [ "$ST" = exited ] && exit "$CODE"
  [ "$ST" = lost ] && exit 1
  exit 0
}

cmd_wait() {
  local id=\${1:-} secs=\${2:-10} dir
  dir=$(job_dir "$id") || exit
  case $secs in
    ''|*[!0-9]*) die "seconds must be a whole number" 2 ;;
  esac
  [ "$secs" -gt "$max_wait" ] && secs=$max_wait
  wait_while_running "$dir" "$secs"
  report "$id" "$dir"
}

cmd_stop() {
  local id=\${1:-} dir pgid i
  dir=$(job_dir "$id") || exit
  job_state "$dir"
  if [ "$ST" = running ] && [ -f "$dir/pgid" ]; then
    pgid=$(cat "$dir/pgid")
    kill -TERM -- "-$pgid" 2>/dev/null
    : > "$dir/stopped"
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

# Starts $cmd as the job in $dir and waits until it exits or $yield seconds pass.
start_job() {
  local id=\${dir##*/} timer i
  printf '%s\\n' "$cmd" > "$dir/command"
  : > "$dir/stdout"
  : > "$dir/stderr"
  set -m
  (
    trap : TERM INT
    bash -lc "export PATH=\\"$root/bin:\\$PATH\\" EVE_JOB_ID=$id
$cmd" < /dev/null > "$dir/stdout" 2> "$dir/stderr"
    printf '%s' "$?" > "$dir/exit.tmp" && mv -f "$dir/exit.tmp" "$dir/exit"
  ) < /dev/null > /dev/null 2>&1 3>&- &
  local pid=$!
  printf '%s' "$pid" > "$dir/pgid"
  trap : USR1
  ( sleep "$yield"; kill -USR1 "$$" ) < /dev/null > /dev/null 2>&1 3>&- &
  timer=$!
  # Providers cancel a call by killing this launcher, often with SIGKILL. A job
  # nobody was told about would run on unseen, so a watchdog stops it then.
  (
    while kill -0 "$$" 2>/dev/null; do sleep 0.5; done
    kill -- "-$timer" 2>/dev/null
    if [ -d "$dir" ] && [ ! -f "$dir/reported" ]; then
      kill -TERM -- "-$pid" 2>/dev/null
      i=0
      while group_alive "$pid" && [ "$i" -lt $((stop_grace * 5)) ]; do
        sleep 0.2
        i=$((i + 1))
      done
      kill -KILL -- "-$pid" 2>/dev/null
      rm -rf "$dir"
    fi
  ) < /dev/null > /dev/null 2>&1 3>&- &
  set +m
  wait "$pid"
  kill -- "-$timer" 2>/dev/null
  trap - USR1
}

cmd_run() {
  local id=$1 yield=$2 cmd=$3 marker=$1 dir os oz ok es ez ek
  if [ -n "\${BASH_EXECUTION_STRING:-}" ]; then
    # Without a writable job root, the caller runs the command directly instead.
    { mkdir -p "$root/bin" "$root/jobs" &&
      printf '#!/usr/bin/env bash\\n%s\\n' "$BASH_EXECUTION_STRING" > "$root/bin/.eve-job.$$" &&
      chmod +x "$root/bin/.eve-job.$$" &&
      mv -f "$root/bin/.eve-job.$$" "$root/bin/eve-job"; } 2>/dev/null ||
      { printf 'eve-job:unsupported:%s\\n' "$marker"; exit 0; }
    # Continue from the installed file so process listings stay short.
    exec bash "$root/bin/eve-job" run "$root" "$@"
  fi
  # Job control reports finished and killed jobs on stderr, so the launcher's
  # stderr goes to /dev/null and the job's stderr is copied to the saved fd 3.
  exec 3>&2 2>/dev/null
  dir="$root/jobs/$id"
  if mkdir "$dir"; then
    start_job
  elif [ -d "$dir" ] && [ "$(cat "$dir/command" 2>/dev/null)" = "$(printf '%s' "$cmd")" ]; then
    # A retried call finds the job its earlier attempt started and keeps waiting on it.
    wait_while_running "$dir" "$yield"
  else
    # A different command already holds this id, so this one gets its own.
    id="$id-$$"
    dir="$root/jobs/$id"
    mkdir "$dir" || { printf 'eve-job:unsupported:%s\\n' "$marker"; exit 0; }
    start_job
  fi
  job_state "$dir"
  unread_range "$dir/stdout" "$cap"; os=$R_START; oz=$R_SIZE; ok=$R_SKIP
  unread_range "$dir/stderr" "$cap"; es=$R_START; ez=$R_SIZE; ek=$R_SKIP
  [ "$ST" = running ] && : > "$dir/reported"
  printf 'eve-job:v1:%s %s %s %s %s %s\\n' "$marker" "$ST" "\${CODE:--}" "$ok" "$ek" "$id"
  copy_range "$dir/stdout" "$os" "$oz"
  copy_range "$dir/stderr" "$es" "$ez" >&3
  [ "$ST" = running ] || rm -rf "$dir"
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

/** What one launch reported: the job's state and output, or that the sandbox cannot host jobs. */
export type BashJobLaunchOutput =
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "job";
      readonly jobId: string;
      readonly state: "exited" | "lost" | "running" | "stopped";
      readonly exitCode: number | undefined;
      readonly stderr: string;
      readonly stderrSkippedBytes: number;
      readonly stdout: string;
      readonly stdoutSkippedBytes: number;
    };

interface BashJobLaunch {
  /** The command to send to the sandbox. */
  readonly command: string;
  /** Reads the launch's output; `undefined` means the launcher itself failed. */
  parse(output: {
    readonly stderr: string;
    readonly stdout: string;
  }): BashJobLaunchOutput | undefined;
}

/**
 * Prepares the command a `bash` call sends to the sandbox. A sandbox without
 * a real process model (no `bash` binary or no `kill`, such as `just-bash`)
 * or without a writable job root reports itself unsupported instead of
 * running anything, and the caller runs the command directly. Only a real
 * `bash` parses the job script, so interpreters that cannot parse it never
 * see it.
 *
 * The report lines carry the requested job id, so output that a login shell
 * prints before the launcher starts cannot be mistaken for the report.
 */
export function createBashJobLaunch(input: {
  readonly command: string;
  readonly jobId: string;
  readonly root: string;
  readonly yieldSeconds: number;
}): BashJobLaunch {
  const args = [input.root, input.jobId, String(input.yieldSeconds), input.command]
    .map(shellQuote)
    .join(" ");
  const unsupported = `eve-job:unsupported:${input.jobId}`;
  const header = new RegExp(
    `(?:^|\\n)eve-job:v1:${input.jobId} (exited|lost|running|stopped) (-?\\d+|-) (\\d+) (\\d+) ([A-Za-z0-9_-]+)\\n`,
  );
  return {
    command:
      `if command -v bash >/dev/null 2>&1 && kill -0 "$$" 2>/dev/null; then ` +
      `exec bash -c ${shellQuote(BASH_JOB_SCRIPT)} eve-job run ${args}; ` +
      `fi; echo ${unsupported}`,
    parse(output) {
      const match = header.exec(output.stdout);
      if (match === null) {
        return output.stdout.split("\n").includes(unsupported)
          ? { kind: "unsupported" }
          : undefined;
      }
      const [, state, code, stdoutSkipped, stderrSkipped, jobId] = match;
      return {
        exitCode: code === "-" ? undefined : Number(code),
        jobId: jobId!,
        kind: "job",
        state: state as "exited" | "lost" | "running" | "stopped",
        stderr: output.stderr,
        stderrSkippedBytes: Number(stderrSkipped),
        stdout: output.stdout.slice(match.index + match[0].length),
        stdoutSkippedBytes: Number(stdoutSkipped),
      };
    },
  };
}
