/**
 * The `eve dev` server child: forked `detached` (its own process group) and
 * bound to the CLI's lifetime through the IPC channel, never through the OS.
 *
 * Why the child is not bound to the parent at the OS level (shared process
 * group, inherited terminal signals):
 *
 * - The TUI puts stdin in raw mode, which disables ISIG: Ctrl+C never becomes
 *   a terminal-generated SIGINT, so same-group signal delivery does nothing in
 *   the mode where Ctrl+C matters most.
 * - In headless mode, same-group delivery would signal parent and child
 *   simultaneously, racing the parent's graceful IPC shutdown against the
 *   child's own signal handler.
 * - macOS has no parent-death signal. IPC `disconnect` is the portable
 *   equivalent: the child self-stops whenever this process exits, for any
 *   reason including SIGKILL (see local-server-child.ts).
 *
 * `detached` makes the child a process-group leader, so close() can escalate
 * to a group-wide SIGTERM/SIGKILL that reaps the entire server tree. Sandbox
 * resources leaked by a crash are reconciled by the cleanup-intent janitor on
 * the next run (see local-server-cleanup.ts).
 */

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import type {
  DevelopmentServer,
  DevelopmentServerHandle,
  DevelopmentServerOptions,
} from "#internal/nitro/host/types.js";

type ChildMessage =
  | {
      type: "progress";
      event: Parameters<NonNullable<DevelopmentServerOptions["onBootProgress"]>>[0];
    }
  | { type: "started"; handle: DevelopmentServerHandle }
  | { type: "failed"; message: string; stack?: string };

const childPath = fileURLToPath(new URL("./local-server-child.js", import.meta.url));

// close() escalation stages. Their sum is DEV_SERVER_CLOSE_BUDGET_MS.
const IPC_SHUTDOWN_GRACE_MS = 550;
const SIGTERM_GRACE_MS = 150;
const SIGKILL_REAP_MS = 100;

/**
 * Worst-case close() duration. Must stay below the forced-exit backstop the
 * dev command arms on its lifecycle (FORCED_EXIT_BACKSTOP_MS in
 * `#cli/shutdown.js`), so a graceful close always beats the backstop and
 * `eve dev` exits 0 after Ctrl+C. Enforced by local-server-process.test.ts.
 */
export const DEV_SERVER_CLOSE_BUDGET_MS =
  IPC_SHUTDOWN_GRACE_MS + SIGTERM_GRACE_MS + SIGKILL_REAP_MS;

export interface DevelopmentServerProcess extends DevelopmentServer {
  wait(): Promise<void>;
}

/** Runs the CLI-owned local server outside the foreground TUI process. */
export function createDevelopmentServer(
  appRoot: string,
  options: DevelopmentServerOptions = {},
): DevelopmentServerProcess {
  let child: ChildProcess | undefined;
  let handoff: Promise<void> | undefined;
  let expectedExit = false;
  let childExited = false;
  const exited = Promise.withResolvers<void>();
  const terminated = Promise.withResolvers<void>();
  void exited.promise.catch(() => undefined);

  const release = () => {
    const active = child;
    if (active === undefined) return;
    child = undefined;
    active.stdout?.destroy();
    active.stderr?.destroy();
    if (active.connected) active.disconnect();
    active.unref();
  };

  const start = (): Promise<DevelopmentServerHandle> => {
    if (child !== undefined) throw new Error("DevelopmentServer.start() was already called.");
    const shellEnvironment = { ...process.env };
    loadDevelopmentEnvironmentFiles(appRoot);
    process.env[EVE_DEV_ENV_FLAG] ??= "1";
    const spawned = fork(
      childPath,
      [
        JSON.stringify({
          existing: options.existing,
          host: options.host,
          port: options.port,
        }),
      ],
      {
        cwd: appRoot,
        detached: true,
        env: { ...shellEnvironment, [EVE_DEV_ENV_FLAG]: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child = spawned;
    spawned.stdout?.on("data", (chunk: Buffer) =>
      (options.output === "stderr" ? process.stderr : process.stdout).write(chunk),
    );
    spawned.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

    return new Promise<DevelopmentServerHandle>((resolve, reject) => {
      let settled = false;
      spawned.once("error", reject);
      spawned.once("exit", (code, signal) => {
        childExited = true;
        terminated.resolve();
        release();
        if (!settled) {
          reject(
            new Error(
              `Development server exited during startup (${String(code)}, ${String(signal)}).`,
            ),
          );
        } else if (expectedExit) {
          exited.resolve();
        } else {
          exited.reject(
            new Error(
              `Development server exited unexpectedly (${String(code)}, ${String(signal)}).`,
            ),
          );
        }
      });
      spawned.on("message", (message: ChildMessage) => {
        if (message.type === "progress") options.onBootProgress?.(message.event);
        if (message.type === "started" && !settled) {
          settled = true;
          resolve(message.handle);
          if (message.handle.kind === "existing") {
            expectedExit = true;
            release();
          }
        }
        if (message.type === "failed" && !settled) {
          settled = true;
          const error = new Error(message.message);
          if (message.stack !== undefined) error.stack = message.stack;
          reject(error);
        }
      });
    });
  };

  return {
    start,
    close() {
      if (handoff !== undefined) return handoff;
      const active = child;
      if (active === undefined) return Promise.resolve();
      expectedExit = true;
      handoff = (async () => {
        if (active.connected) active.send({ type: "shutdown" });
        if (
          await terminatesWithin(
            active,
            terminated.promise,
            () => childExited,
            IPC_SHUTDOWN_GRACE_MS,
          )
        )
          return;
        signalProcessGroup(active, "SIGTERM");
        if (await terminatesWithin(active, terminated.promise, () => childExited, SIGTERM_GRACE_MS))
          return;
        signalProcessGroup(active, "SIGKILL");
        await terminatesWithin(active, terminated.promise, () => childExited, SIGKILL_REAP_MS);
        release();
      })();
      return handoff;
    },
    wait: () => exited.promise,
  };
}

async function terminatesWithin(
  child: ChildProcess,
  exited: Promise<void>,
  childExited: () => boolean,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  await settlesOrTimesOut(exited, ms);
  while (!hasTerminated(child, childExited()) && Date.now() < deadline) {
    await sleep(Math.min(25, deadline - Date.now()));
  }
  return hasTerminated(child, childExited());
}

async function settlesOrTimesOut(operation: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasTerminated(child: ChildProcess, childExited: boolean): boolean {
  return childExited && !isProcessGroupAlive(child);
}

function isProcessGroupAlive(child: ChildProcess): boolean {
  if (process.platform === "win32" || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}
