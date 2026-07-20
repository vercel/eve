import { access, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, relative, sep } from "node:path";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH } from "#internal/workflow/local-world-data-directory.js";
import { captureVercel, resolveVercelInvocation } from "#setup/primitives/run-vercel.js";

const VERCEL_VERSION_TIMEOUT_MS = 5_000;

/**
 * Environment facts captured once per `eve dev` process, written into the
 * diagnostic dump so a shared log always travels with the toolchain state
 * that produced it.
 */
export interface DevEnvironmentInfo {
  readonly eveVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly vercelCliVersion?: string;
  readonly vercelCliPath?: string;
  /** Local durable session store measurements; absent when the directory does not exist yet. */
  readonly sessionsDirectory?: {
    readonly path: string;
    readonly files: number;
    readonly bytes: number;
  };
}

/**
 * Aggregate counters for the TUI process's session activity. Reported by
 * the renderer at each turn boundary so the dump stays current even if
 * the process dies mid-session.
 */
export interface DevSessionStats {
  readonly prompts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tool invocations observed, keyed by tool name. */
  readonly toolCalls: Readonly<Record<string, number>>;
  /** Distinct subagent dispatches that produced observable output. */
  readonly subagents: number;
}

export interface DevDiagnosticDump {
  readonly path: string;
  /** Project-relative reference, forward slashes on every platform. */
  readonly displayPath: string;
  updateSessionStats(stats: DevSessionStats): void;
  close(): Promise<void>;
}

export interface CreateDevDiagnosticDumpOptions {
  /** Injectable environment collector; defaults to {@link collectDevEnvironmentInfo}. */
  readonly environment?: () => Promise<DevEnvironmentInfo>;
  readonly now?: () => Date;
}

/**
 * Creates the environment dump paired with one dev diagnostic log: the same
 * instance name with a `.dump` extension. The environment section is
 * collected in the background and written as soon as it resolves; session
 * stats rewrite the file on every update. Like the log sink, write failures
 * disable the dump silently — never through stderr, which the TUI captures.
 */
export function createDevDiagnosticDump(
  appRoot: string,
  logPath: string,
  options: CreateDevDiagnosticDumpOptions = {},
): DevDiagnosticDump {
  const path = logPath.replace(/\.log$/, ".dump");
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();

  let environment: DevEnvironmentInfo | undefined;
  let stats: DevSessionStats | undefined;
  let queue = Promise.resolve();
  let failed = false;
  let closed = false;

  const write = () => {
    if (closed || failed) return;
    const content = formatDump({
      at: now(),
      durationMs: now().getTime() - startedAt,
      environment,
      stats,
    });
    queue = queue
      .then(() => writeFile(path, content, { encoding: "utf8", mode: 0o600 }))
      .catch(() => {
        failed = true;
      });
  };

  write();
  void (options.environment ?? (() => collectDevEnvironmentInfo(appRoot)))()
    .then((collected) => {
      environment = collected;
      write();
    })
    .catch(() => {
      // Collection is best-effort; the dump keeps its pending marker.
    });

  return {
    path,
    displayPath: relative(appRoot, path).split(sep).join("/"),
    updateSessionStats(next) {
      stats = next;
      write();
    },
    async close() {
      if (closed) return;
      write();
      closed = true;
      await queue;
    },
  };
}

/**
 * One pretty-printed JSON document. `environment` is `null` until the
 * background collection resolves; `session` is `null` until the first
 * stats report. Parseable standalone (`jq . <file>.dump`) and, because a
 * JSON document followed by JSON Lines is a valid JSON value stream,
 * composable with the log by plain concatenation (`eve logs --dump`).
 */
function formatDump(input: {
  readonly at: Date;
  readonly durationMs: number;
  readonly environment: DevEnvironmentInfo | undefined;
  readonly stats: DevSessionStats | undefined;
}): string {
  const document = {
    updatedAt: input.at.toISOString(),
    durationMs: input.durationMs,
    environment: input.environment ?? null,
    session: input.stats ?? null,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Collects the real environment facts for {@link createDevDiagnosticDump}. */
export async function collectDevEnvironmentInfo(appRoot: string): Promise<DevEnvironmentInfo> {
  const [vercelCli, sessionsDirectory] = await Promise.all([
    detectVercelCli(appRoot),
    measureSessionsDirectory(appRoot),
  ]);

  const info: {
    -readonly [Key in keyof DevEnvironmentInfo]: DevEnvironmentInfo[Key];
  } = {
    eveVersion: resolveInstalledPackageInfo().version,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    ...vercelCli,
  };
  if (sessionsDirectory !== undefined) info.sessionsDirectory = sessionsDirectory;
  return info;
}

async function detectVercelCli(
  appRoot: string,
): Promise<{ vercelCliVersion?: string; vercelCliPath?: string }> {
  // `captureVercel` owns the invocation resolution, capture, and hard
  // deadline; the invocation is re-resolved only to report which binary
  // answered (a workspace-local install beats the PATH lookup).
  const invocation = resolveVercelInvocation(appRoot);
  const [result, path] = await Promise.all([
    captureVercel(["--version"], {
      cwd: appRoot,
      nonInteractive: true,
      timeoutMs: VERCEL_VERSION_TIMEOUT_MS,
    }),
    invocation.command === "vercel" ? findOnPath("vercel") : Promise.resolve(invocation.command),
  ]);
  const output = result.ok ? result.stdout : `${result.failure.stdout}\n${result.failure.stderr}`;
  const version = /(\d+\.\d+\.\d+\S*)/.exec(output)?.[1];
  const detected: { vercelCliVersion?: string; vercelCliPath?: string } = {};
  if (version !== undefined) detected.vercelCliVersion = version;
  if (path !== undefined) detected.vercelCliPath = path;
  return detected;
}

async function findOnPath(executable: string): Promise<string | undefined> {
  const entries = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const candidate = join(entry, executable);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep scanning.
    }
  }
  return undefined;
}

/**
 * Counts files and total bytes under the app's local durable session store
 * (`.eve/.workflow-data`). Returns `undefined` when the directory does not
 * exist yet.
 */
export async function measureSessionsDirectory(
  appRoot: string,
): Promise<DevEnvironmentInfo["sessionsDirectory"]> {
  const directory = join(appRoot, LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH);
  let entries;
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch {
    return undefined;
  }

  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files += 1;
    try {
      bytes += (await stat(join(entry.parentPath, entry.name))).size;
    } catch {
      // Entries can vanish while a live session compacts; count what remains.
    }
  }
  return { path: LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH, files, bytes };
}
