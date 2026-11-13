import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { theme } from "./theme.ts";

const DEFAULT_PORT = 3000;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_TIMEOUT_MS = 60_000;
const FORCE_KILL_GRACE_MS = 2_000;
const TERMINATE_GRACE_MS = 5_000;
const PROC_ROOT = "/proc";

/**
 * Where the runner records the apps it already built. `run-all.mjs` points this
 * at a fresh directory per run, so one run builds each app once and every later
 * smoke test starts the same `.output`. Unset when a single test runs alone,
 * which then builds as it always did.
 */
const BUILD_STATE_DIR = process.env.EVE_TUI_BUILD_STATE_DIR;

export type AgentServerMode = "built" | "dev";

export interface AgentServerHandle {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export interface PnpmCommand {
  readonly args: readonly string[];
  readonly label: string;
}

export interface AgentServerCommandPlan {
  readonly build?: PnpmCommand;
  readonly start: PnpmCommand;
}

/**
 * Builds an agent app, starts the built output with `eve start`, and waits for
 * `/eve/v1/health` plus a matching `/eve/v1/info` agent identity before
 * returning. Caller must call `stop()` when done (or rely on the cleanup the
 * `run()` helper installs).
 *
 * Smoke tests interact with the server purely over HTTP, there is no
 * stdout-marker plumbing on this surface. Structured signals belong on a
 * dev-only HTTP route (e.g. `POST /eve/v1/dev/schedules/:scheduleId`) so
 * the framework, not the test harness, owns the contract.
 */
export async function startAgentServer(input: {
  readonly appName: string;
  readonly mode?: AgentServerMode;
  readonly port?: number;
  readonly startEnv?: NodeJS.ProcessEnv;
}): Promise<AgentServerHandle> {
  const plan = createAgentServerCommandPlan(input);
  const mode = input.mode ?? "built";
  const port = input.port ?? DEFAULT_PORT;
  const baseUrl = `http://localhost:${port}`;

  if (plan.build !== undefined) {
    if (await builtInThisRun(input.appName)) {
      console.log(theme.muted(`[tui] reusing the "${input.appName}" build from this run ...`));
    } else {
      console.log(theme.muted(`[tui] building "${input.appName}" before smoke run ...`));
      await runPnpmCommand({
        ...plan.build,
        env: input.startEnv ?? process.env,
      });
      await recordBuild(input.appName);
    }
  }

  console.log(theme.muted(`[tui] starting "${input.appName}" ${mode} server on ${baseUrl} ...`));

  // Built smoke servers run on the local machine. `eve start` does not set
  // EVE_DEV, so set it here to let `localDev()` authenticate local requests.
  const serverEnv = { ...(input.startEnv ?? process.env), EVE_DEV: "1" };

  const child = spawnServerProcess({
    args: plan.start.args,
    env: serverEnv,
  });

  // Forward the server's stdout/stderr to ours while running. Once we
  // start tearing the server down, stop forwarding: the workflow runtime's
  // last in-flight self-call loses its connection on shutdown and emits a
  // noisy ECONNRESET stack trace that has nothing to do with the test result.
  let suppressOutput = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (!suppressOutput) process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (!suppressOutput) process.stderr.write(chunk);
  });

  child.on("error", (error) => {
    console.error(theme.danger("[tui] failed to spawn agent server:"), error);
  });

  // Captured once at spawn time: `exit` fires exactly once, so any listener
  // attached after the fact would wait forever. Every teardown wait races
  // against this single promise instead.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    suppressOutput = true;
    await terminate(child, exited);
  };

  try {
    await waitForAgentServer({
      appName: input.appName,
      baseUrl,
      child,
    });
  } catch (error) {
    await stop();
    throw error;
  }

  console.log(theme.muted(`[tui] "${input.appName}" ${mode} server is ready.`));
  return { baseUrl, stop };
}

export function createAgentServerCommandPlan(input: {
  readonly appName: string;
  readonly mode?: AgentServerMode;
  readonly port?: number;
}): AgentServerCommandPlan {
  const mode = input.mode ?? "built";
  const port = input.port ?? DEFAULT_PORT;

  if (mode === "dev") {
    return {
      start: {
        args: ["--filter", input.appName, "run", "dev", "--no-ui", "--port", String(port)],
        label: `start ${input.appName}`,
      },
    };
  }

  return {
    build: {
      args: ["--filter", input.appName, "run", "build"],
      label: `build ${input.appName}`,
    },
    start: {
      args: [
        "--filter",
        input.appName,
        "exec",
        "eve",
        "start",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      label: `start ${input.appName}`,
    },
  };
}

function spawnServerProcess(input: {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): ChildProcess {
  return spawn("pnpm", input.args, {
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Make `child` the leader of a new POSIX process group via
    // `setsid()`. This lets `terminate()` signal the entire group
    // (pnpm + the `eve` Node grandchild it spawns) with one
    // `process.kill(-pid, ...)`. Without it, signalling only the
    // immediate child reaps `pnpm` but orphans `eve`, and the orphan
    // keeps the write end of these stdout/stderr pipes open, pinning
    // the smoke process after the test logic completes.
    detached: true,
  });
}

/**
 * True when this run already built `appName`. A single smoke test run on its
 * own leaves the variable unset and always builds.
 */
async function builtInThisRun(appName: string): Promise<boolean> {
  if (BUILD_STATE_DIR === undefined) return false;

  try {
    await access(join(BUILD_STATE_DIR, appName));
    return true;
  } catch {
    return false;
  }
}

async function recordBuild(appName: string): Promise<void> {
  if (BUILD_STATE_DIR === undefined) return;

  await mkdir(BUILD_STATE_DIR, { recursive: true });
  await writeFile(join(BUILD_STATE_DIR, appName), "");
}

async function runPnpmCommand(input: {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly label: string;
}): Promise<void> {
  const child = spawn("pnpm", input.args, {
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal !== null) {
        reject(new Error(`pnpm ${input.label} exited due to signal ${signal}.`));
        return;
      }

      reject(new Error(`pnpm ${input.label} exited with code ${String(code)}.`));
    });
  });
}

async function waitForAgentServer(input: {
  readonly appName: string;
  readonly baseUrl: string;
  readonly child: ChildProcess;
}): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (input.child.exitCode !== null) {
      throw new Error(
        `Agent server process exited (code=${input.child.exitCode}) before becoming healthy.`,
      );
    }

    const healthResponse = await fetch(`${input.baseUrl}/eve/v1/health`, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
    if (healthResponse?.ok) {
      const infoResponse = await fetch(`${input.baseUrl}/eve/v1/info`, {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
      if (infoResponse?.ok) {
        const agentName = getAgentNameFromInfoPayload(await infoResponse.json());
        if (agentName === input.appName) return;
        if (agentName !== undefined) {
          throw new Error(
            `Expected smoke target ${JSON.stringify(input.appName)} at ${input.baseUrl}, but ${JSON.stringify(agentName)} is responding there.`,
          );
        }
        throw new Error(
          `Agent server ${JSON.stringify(input.appName)} returned an unrecognized identity payload from ${input.baseUrl}/eve/v1/info.`,
        );
      }
    }

    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Agent server ${JSON.stringify(input.appName)} did not become healthy with the expected identity within ${HEALTH_TIMEOUT_MS / 1000}s at ${input.baseUrl}.`,
  );
}

/** Reads the agent name from a versioned `/eve/v1/info` response. */
export function getAgentNameFromInfoPayload(payload: unknown): string | undefined {
  if (!isRecord(payload) || payload.kind !== "eve-agent-info" || payload.version !== 5) {
    return undefined;
  }

  const agent = payload.agent;
  return isRecord(agent) && typeof agent.name === "string" ? agent.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function terminate(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.pid === undefined) return;

  console.log(theme.muted("[tui] stopping agent server..."));
  killProcessGroup(child, "SIGTERM");
  await waitForTermination(child, exited, TERMINATE_GRACE_MS);

  if (!hasTerminated(child)) {
    console.warn(theme.warning("[tui] agent server did not exit on SIGTERM; sending SIGKILL."));
    killProcessGroup(child, "SIGKILL");
    await waitForTermination(child, exited, FORCE_KILL_GRACE_MS);

    if (!hasTerminated(child)) {
      console.warn(
        theme.warning("[tui] agent server still did not report exit after SIGKILL; detaching."),
      );
      child.unref();
    }
  }

  // Defensively close our read ends of the stdio pipes. Even after
  // the immediate child reports exit, a still-pending descendant
  // (e.g. a wrapper that forked-and-forgot before our group signal
  // arrived) can hold the write ends open, which keeps Node's
  // `Readable` handles alive and prevents the smoke process from
  // draining its event loop.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Sends `signal` to the entire process group whose leader is
 * {@link child}. Requires `detached: true` at spawn time so the
 * child actually became a group leader.
 *
 * Falls back to a direct PID signal if the group call fails, most
 * commonly because the group has already collapsed (every member
 * exited before us) or we're on a platform without POSIX process
 * groups.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone, nothing to do.
    }
  }
}

function isProcessGroupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
  } catch {
    return false;
  }

  const live = groupHasLiveMember(child.pid);
  return live ?? true;
}

/**
 * True when `pgid` still holds a process that is not a zombie, or `undefined`
 * where the process table is unreadable (no `/proc`, or a platform this doesn't
 * cover).
 *
 * A zombie has already released its file descriptors, sockets, and ports, and
 * only waits for its parent to reap it. Signalling the group cannot retire one,
 * so counting zombies as alive makes every teardown wait out both graces — the
 * smoke servers leave a re-parented `pnpm` zombie behind on Linux CI.
 */
function groupHasLiveMember(pgid: number): boolean | undefined {
  let entries: string[];
  try {
    entries = readdirSync(PROC_ROOT);
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;

    const stat = readProcStat(entry);
    if (stat === undefined || stat.pgid !== pgid) continue;
    if (stat.state !== "Z") return true;
  }
  return false;
}

function readProcStat(pid: string): { state: string; pgid: number } | undefined {
  let stat: string;
  try {
    stat = readFileSync(join(PROC_ROOT, pid, "stat"), "utf8");
  } catch {
    // The process exited while we scanned; it is not alive either way.
    return undefined;
  }

  // `comm` may hold spaces and parentheses, so fields are read after it.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = fields[0];
  const pgid = Number(fields[2]);
  if (state === undefined || !Number.isInteger(pgid)) return undefined;

  return { state, pgid };
}

/**
 * True once the direct child has exited (by code or by signal — a
 * signal-killed process reports `exitCode === null` with `signalCode`
 * set) and no live descendant in its process group remains.
 */
function hasTerminated(child: ChildProcess): boolean {
  const childExited = child.exitCode !== null || child.signalCode !== null;
  return childExited && !isProcessGroupAlive(child);
}

/**
 * Waits up to `graceMs` for {@link hasTerminated}. The direct child's exit
 * is event-driven via `exited`; group descendants can only be observed by
 * polling, so this re-checks on a short interval after the exit event.
 */
async function waitForTermination(
  child: ChildProcess,
  exited: Promise<void>,
  graceMs: number,
): Promise<void> {
  const deadline = Date.now() + graceMs;
  await Promise.race([exited, sleep(graceMs)]);
  while (!hasTerminated(child) && Date.now() < deadline) {
    await sleep(50);
  }
}
