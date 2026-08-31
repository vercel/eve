import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * An install runs the project's package manager, which is slow but not
 * unbounded. The cap exists so a wedged child cannot hold the authored-source
 * watcher suspended for the rest of the session.
 */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const TERMINATION_GRACE_MS = 5_000;
/** Enough to retain the terminal protocol event without accumulating child output indefinitely. */
const OUTPUT_LIMIT = 64_000;

/** Minimal spawn surface, injectable so tests need no real child process. */
export type SpawnLike = typeof nodeSpawn;

export type EveAddOutcome =
  | { readonly kind: "installed" }
  /** The child ended in a state that needs a terminal (a setup question). */
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

interface HeadlessEvent {
  readonly version?: number;
  readonly type: string;
  readonly item?: string;
}

function terminateChildTree(child: ReturnType<SpawnLike>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

function isChildTreeAlive(child: ReturnType<SpawnLike>): boolean {
  if (process.platform === "win32" || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the `eve` executable the way eve already resolves setup binaries:
 * from the application's own dependency graph and the package's declared bin,
 * never a `PATH` lookup. A `PATH` hit could be any version, or not eve at all.
 */
export async function resolveEveExecutable(appRoot: string): Promise<string> {
  const packageJsonPath = findPackageJSON("eve", pathToFileURL(resolve(appRoot, "package.json")));
  if (packageJsonPath === undefined) {
    throw new Error(
      `The "eve" package is not installed under ${appRoot}, so registry items cannot be installed from here.`,
    );
  }
  const packageRoot = dirname(packageJsonPath);
  const manifest: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const bin =
    typeof manifest === "object" && manifest !== null
      ? (manifest as { bin?: unknown }).bin
      : undefined;
  const declared =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null
        ? (bin as Record<string, unknown>).eve
        : undefined;
  if (typeof declared !== "string" || declared.length === 0) {
    throw new Error(`The installed "eve" package does not declare an "eve" binary.`);
  }

  const executable = resolve(packageRoot, declared);
  const packageRelativePath = relative(packageRoot, executable);
  if (packageRelativePath.startsWith("..") || isAbsolute(packageRelativePath)) {
    throw new Error(`The installed "eve" package declares its binary outside the package.`);
  }
  return executable;
}

/**
 * Reads the one terminal event `eve add --non-interactive` prints.
 *
 * The registry SDK writes its own progress to the same streams, so this scans
 * for the JSON line rather than assuming the output is only NDJSON.
 */
export function readTerminalHeadlessEvent(output: string): HeadlessEvent | undefined {
  let terminal: HeadlessEvent | undefined;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as HeadlessEvent;
    if (
      event.version === 1 &&
      (event.type === "completed" ||
        event.type === "blocked" ||
        event.type === "failed" ||
        event.type === "cancelled")
    ) {
      terminal = event;
    }
  }
  return terminal;
}

/**
 * Runs `eve add <address> --non-interactive --skip-setup` in `appRoot`.
 *
 * The argv shape is fixed here rather than composed by a caller: the
 * subcommand, the interaction mode, and the setup opt-out are the constraints
 * that make this safe to expose, so none of them is a parameter.
 *
 * `--skip-setup` is redundant given the split rule, which reads the cached
 * catalog index while the manifest is fetched fresh at install. If the two ever
 * disagree, this flag is what keeps a setup flow from starting in a process
 * with no way to answer it.
 */
export async function runEveAdd(input: {
  readonly address: string;
  readonly appRoot: string;
  readonly signal?: AbortSignal | undefined;
  readonly spawn?: SpawnLike | undefined;
}): Promise<EveAddOutcome> {
  const executable = await resolveEveExecutable(input.appRoot);
  const spawn = input.spawn ?? nodeSpawn;

  return await new Promise<EveAddOutcome>((settle) => {
    const child = spawn(
      process.execPath,
      [executable, "add", input.address, "--non-interactive", "--skip-setup"],
      {
        cwd: input.appRoot,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    const collect = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-OUTPUT_LIMIT);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let settled = false;
    let stopOutcome: EveAddOutcome | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    let treePoll: NodeJS.Timeout | undefined;
    const finish = (outcome: EveAddOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill !== undefined) clearTimeout(hardKill);
      if (treePoll !== undefined) clearTimeout(treePoll);
      input.signal?.removeEventListener("abort", abort);
      settle(outcome);
    };
    const finishAfterTreeExits = (outcome: EveAddOutcome) => {
      if (isChildTreeAlive(child)) {
        treePoll = setTimeout(() => finishAfterTreeExits(outcome), 25);
        treePoll.unref?.();
        return;
      }
      finish(stopOutcome ?? outcome);
    };
    const stop = (outcome: EveAddOutcome) => {
      if (stopOutcome !== undefined) return;
      stopOutcome = outcome;
      terminateChildTree(child, "SIGTERM");
      hardKill = setTimeout(() => terminateChildTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
      hardKill.unref?.();
    };
    const abort = () => {
      stop({ kind: "failed", message: `Installing ${input.address} was cancelled.` });
    };
    const timer = setTimeout(() => {
      stop({
        kind: "failed",
        message: `Installing ${input.address} did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes.`,
      });
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();
    if (input.signal?.aborted === true) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", () => {
      stop({
        kind: "failed",
        message: `Could not run \`eve add ${input.address}\`. Run the command in a terminal for details.`,
      });
    });
    child.on("close", (code: number | null) => {
      let outcome: EveAddOutcome;
      const event = readTerminalHeadlessEvent(output);
      if (code === 0 && event?.type === "completed" && event.item === input.address) {
        outcome = { kind: "installed" };
      } else if (event?.type === "blocked" && event.item === input.address) {
        outcome = {
          kind: "blocked",
          message: `Installing ${input.address} stopped for input that only a terminal can supply.`,
        };
      } else {
        outcome = {
          kind: "failed",
          message: `\`eve add ${input.address}\` failed. Run it in a terminal for details.`,
        };
      }
      finishAfterTreeExits(outcome);
    });
  });
}
