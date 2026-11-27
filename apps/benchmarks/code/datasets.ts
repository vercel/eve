import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { DatasetName, TaskCollectHook, TaskSpec } from "./types.ts";

const exec = promisify(execFile);

export interface DatasetSource {
  readonly name: DatasetName;
  readonly version: string;
  readonly repoUrl: string;
  readonly commit: string;
  readonly taskPrefix: string;
  readonly tasks: readonly string[];
  readonly defaultAgentTimeoutSec: number;
  readonly injectNeutralGitIdentity: boolean;
}

export const DATASET_SOURCES: Readonly<Record<DatasetName, DatasetSource>> = {
  "deepswe-lean": {
    name: "deepswe-lean",
    version: "v1",
    repoUrl: "https://github.com/datacurve-ai/deep-swe.git",
    commit: "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea",
    taskPrefix: "tasks",
    tasks: [
      "dateutil-rfc5545-timezone-interop",
      "tengo-destructuring-bindings",
      "testem-per-launcher-reports",
      "anko-typed-variable-bindings",
      "sql-formatter-bigquery-pipe-formatting",
      "sqlite-utils-safe-import-checkpoints",
      "go-genai-streamed-function-args",
      "prometheus-typed-label-sorting",
      "cliffy-config-file-parsing",
      "returns-validated-error-accumulation",
      "bandit-incremental-cache-control",
      "mnamer-daemon-watch-lifecycle",
    ],
    defaultAgentTimeoutSec: 1200,
    injectNeutralGitIdentity: true,
  },
  "swe-lean": {
    name: "swe-lean",
    version: "v4",
    repoUrl: "https://github.com/harbor-framework/terminal-bench-2-1.git",
    commit: "320a8be8b625ee8eb46481f7a397648d7d085775",
    taskPrefix: "",
    tasks: [
      "cancel-async-tasks",
      "git-multibranch",
      "sanitize-git-repo",
      "log-summary-date-ranges",
    ],
    defaultAgentTimeoutSec: 600,
    injectNeutralGitIdentity: false,
  },
};

const NEUTRAL_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "code-bench",
  GIT_AUTHOR_EMAIL: "code-bench@localhost",
  GIT_COMMITTER_NAME: "code-bench",
  GIT_COMMITTER_EMAIL: "code-bench@localhost",
};

/**
 * Minimal TOML parser covering the subset used by Harbor / DeepSWE `task.toml` files:
 * `[section]`, `[[array.of.tables]]`, strings, numbers, booleans, and string arrays.
 */
export function parseTaskToml(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const lines = source.split(/\r?\n/u);

  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i] ?? "").trim();
    if (!raw) continue;

    if (raw.startsWith("[[") && raw.endsWith("]]")) {
      const path = raw.slice(2, -2).trim().split(".");
      current = ensureArrayTable(root, path);
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const path = raw.slice(1, -1).trim().split(".");
      current = ensureTable(root, path);
      continue;
    }

    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim().replace(/^"|"$/gu, "");
    let valueText = raw.slice(eq + 1).trim();

    while (valueText.startsWith("[") && !isBalancedBrackets(valueText) && i + 1 < lines.length) {
      i++;
      valueText += ` ${stripComment(lines[i] ?? "").trim()}`;
    }

    current[key] = parseTomlValue(valueText);
  }
  return root;
}

function stripComment(line: string): string {
  let inQuotes = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inQuotes) {
      if (ch === "\\" && quote === '"') escaped = true;
      else if (ch === quote) inQuotes = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuotes = true;
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function isBalancedBrackets(text: string): boolean {
  let depth = 0;
  let inQuotes = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inQuotes) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth <= 0;
}

function parseTomlValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/u.test(raw)) return Number(raw);
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return JSON.parse(raw);
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    const items: unknown[] = [];
    let token = "";
    let inQuotes = false;
    let escaped = false;
    for (const ch of inner) {
      if (escaped) {
        token += ch;
        escaped = false;
        continue;
      }
      if (inQuotes) {
        token += ch;
        if (ch === "\\") escaped = true;
        else if (ch === '"') inQuotes = false;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        token += ch;
      } else if (ch === ",") {
        if (token.trim()) items.push(parseTomlValue(token.trim()));
        token = "";
      } else {
        token += ch;
      }
    }
    if (token.trim()) items.push(parseTomlValue(token.trim()));
    return items;
  }
  return raw;
}

function ensureTable(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> {
  let cursor = root;
  for (const part of path) {
    const existing = cursor[part];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  return cursor;
}

function ensureArrayTable(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> {
  const parent = ensureTable(root, path.slice(0, -1));
  const key = path.at(-1)!;
  if (!Array.isArray(parent[key])) parent[key] = [];
  const next: Record<string, unknown> = {};
  (parent[key] as unknown[]).push(next);
  return next;
}

async function ensureDatasetCheckout(source: DatasetSource, cacheDir: string): Promise<string> {
  const repoDir = join(cacheDir, "datasets", `${source.name}-${source.commit.slice(0, 12)}`);
  const marker = join(repoDir, ".synced");
  const exists = await stat(marker).then(
    () => true,
    () => false,
  );
  if (exists) return repoDir;

  await mkdir(repoDir, { recursive: true });
  await exec("git", ["init", "--quiet"], { cwd: repoDir });
  await exec("git", ["remote", "remove", "origin"], { cwd: repoDir }).catch(() => {});
  await exec("git", ["remote", "add", "origin", source.repoUrl], { cwd: repoDir });
  await exec("git", ["fetch", "--quiet", "--depth=1", "origin", source.commit], {
    cwd: repoDir,
    maxBuffer: 16 * 1024 * 1024,
  });
  await exec("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: repoDir });
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
  if (stdout.trim() !== source.commit) {
    throw new Error(
      `Dataset ${source.name} checked out ${stdout.trim()}, expected ${source.commit}`,
    );
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(marker, `${source.commit}\n`);
  return repoDir;
}

export async function loadTaskFromDir(
  dataset: DatasetName,
  taskName: string,
  dir: string,
): Promise<TaskSpec> {
  const source = DATASET_SOURCES[dataset];
  const [tomlRaw, instruction] = await Promise.all([
    readFile(join(dir, "task.toml"), "utf8"),
    readFile(join(dir, "instruction.md"), "utf8"),
  ]);
  const parsed = parseTaskToml(tomlRaw);
  const environment = (parsed.environment ?? {}) as Record<string, unknown>;
  const agent = (parsed.agent ?? {}) as Record<string, unknown>;
  const verifier = (parsed.verifier ?? {}) as Record<string, unknown>;

  const rawAgentTimeout =
    typeof agent.timeout_sec === "number" ? agent.timeout_sec : source.defaultAgentTimeoutSec;
  const agentTimeoutSec = Math.min(rawAgentTimeout, source.defaultAgentTimeoutSec);
  const verifierTimeoutSec = typeof verifier.timeout_sec === "number" ? verifier.timeout_sec : 600;
  const dockerImage = typeof environment.docker_image === "string" ? environment.docker_image : "";
  const envTable = (environment.env ?? {}) as Record<string, unknown>;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envTable)) {
    if (typeof value === "string") env[key] = value;
  }
  if (source.injectNeutralGitIdentity) {
    Object.assign(env, NEUTRAL_GIT_ENV);
  }

  const collectHooks: TaskCollectHook[] = Array.isArray(verifier.collect)
    ? verifier.collect
        .filter(
          (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
        )
        .map((entry) => ({
          command: String(entry.command ?? ""),
          timeoutSec: typeof entry.timeout_sec === "number" ? entry.timeout_sec : 300,
        }))
        .filter((entry) => entry.command.length > 0)
    : [];

  const artifacts = Array.isArray(parsed.artifacts)
    ? parsed.artifacts.filter((item): item is string => typeof item === "string")
    : [];

  return {
    name: taskName,
    dataset,
    dir,
    instruction,
    dockerImage,
    agentTimeoutSec,
    verifierTimeoutSec,
    separateVerifier: verifier.environment_mode === "separate",
    collectHooks,
    artifacts,
    env,
    cpus: typeof environment.cpus === "number" ? environment.cpus : 2,
    memoryMb: typeof environment.memory_mb === "number" ? environment.memory_mb : 4096,
  };
}

export async function loadDatasetTasks(
  dataset: DatasetName,
  cacheDir: string,
  taskFilter?: string,
): Promise<TaskSpec[]> {
  const source = DATASET_SOURCES[dataset];
  const selected = taskFilter
    ? source.tasks.filter((name) => name === taskFilter)
    : [...source.tasks];
  if (selected.length === 0) {
    throw new Error(
      `Task "${taskFilter}" is not in ${dataset}. Available: ${source.tasks.join(", ")}`,
    );
  }
  const repoDir = await ensureDatasetCheckout(source, cacheDir);
  return await Promise.all(
    selected.map((name) => {
      const taskDir = source.taskPrefix
        ? join(repoDir, source.taskPrefix, name)
        : join(repoDir, name);
      return loadTaskFromDir(dataset, name, taskDir);
    }),
  );
}
