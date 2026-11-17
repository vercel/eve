import { access, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, relative, sep } from "node:path";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  displayLocalWorkflowWorldDataDirectory,
  resolveLocalWorkflowWorldDataDirectory,
} from "#internal/workflow/local-world-data-directory.js";
import { captureVercel, resolveVercelInvocation } from "#setup/primitives/run-vercel.js";

const VERCEL_VERSION_TIMEOUT_MS = 5_000;

export interface DevEnvironmentInfo {
  readonly eveVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly vercelCliVersion?: string;
  readonly vercelCliPath?: string;
  readonly sessionsDirectory?: {
    readonly path: string;
    readonly files: number;
    readonly bytes: number;
  };
}

export interface DevSessionStats {
  readonly prompts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: Readonly<Record<string, number>>;
  readonly subagents: number;
}

export interface DevDiagnosticDump {
  readonly path: string;
  readonly displayPath: string;
  updateSessionStats(stats: DevSessionStats): void;
  close(): Promise<void>;
}

export interface CreateDevDiagnosticDumpOptions {
  readonly environment?: () => Promise<DevEnvironmentInfo>;
  readonly now?: () => Date;
}

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
    .catch(() => {});

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

async function collectDevEnvironmentInfo(appRoot: string): Promise<DevEnvironmentInfo> {
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
    } catch {}
  }
  return undefined;
}

export async function measureSessionsDirectory(
  appRoot: string,
): Promise<DevEnvironmentInfo["sessionsDirectory"]> {
  const directory = resolveLocalWorkflowWorldDataDirectory(appRoot);
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
    } catch {}
  }
  return { path: displayLocalWorkflowWorldDataDirectory(appRoot), files, bytes };
}
