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
/** Only the tail of the child's output is worth reporting on failure. */
const OUTPUT_TAIL_LIMIT = 4_000;

/** Minimal spawn surface, injectable so tests need no real child process. */
export type SpawnLike = typeof nodeSpawn;

export type EveAddOutcome =
  | { readonly kind: "installed" }
  /** The child ended in a state that needs a terminal (a setup question). */
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

interface HeadlessEvent {
  readonly type: string;
  readonly message?: string;
  readonly item?: string;
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
      event.type === "completed" ||
      event.type === "blocked" ||
      event.type === "failed" ||
      event.type === "cancelled"
    ) {
      terminal = event;
    }
  }
  return terminal;
}

function tail(output: string): string {
  return output.length <= OUTPUT_TAIL_LIMIT ? output : `…${output.slice(-OUTPUT_TAIL_LIMIT)}`;
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
      { cwd: input.appRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    const collect = (chunk: Buffer | string) => {
      output += String(chunk);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let settled = false;
    const finish = (outcome: EveAddOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      settle(outcome);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish({ kind: "failed", message: `Installing ${input.address} was cancelled.` });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        kind: "failed",
        message: `Installing ${input.address} did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes.`,
      });
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();
    input.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error: Error) => {
      finish({ kind: "failed", message: error.message });
    });
    child.on("close", (code: number | null) => {
      const event = readTerminalHeadlessEvent(output);
      if (code === 0 && event?.type === "completed") {
        finish({ kind: "installed" });
        return;
      }
      if (event?.type === "blocked") {
        finish({
          kind: "blocked",
          message:
            event.message ??
            `Installing ${input.address} stopped for input that only a terminal can supply.`,
        });
        return;
      }
      finish({
        kind: "failed",
        message:
          event?.message ??
          `\`eve add ${input.address}\` exited with code ${String(code)}.\n${tail(output)}`.trim(),
      });
    });
  });
}
