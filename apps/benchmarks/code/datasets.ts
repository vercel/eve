import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { exists } from "./harnesses/node-runtime.ts";
import type { CollectHook, DatasetName, TaskSpec } from "./types.ts";

const execFileAsync = promisify(execFile);

interface DatasetLock {
  readonly name: DatasetName;
  readonly version: string;
  readonly repoUrl: string;
  readonly commit: string;
  readonly taskPaths: readonly string[];
  readonly maxAgentTimeoutSec?: number;
  readonly defaultEnv?: Readonly<Record<string, string>>;
}

export const DATASET_LOCKS: Readonly<Record<DatasetName, DatasetLock>> = {
  "swe-lean": {
    name: "swe-lean",
    version: "v4",
    repoUrl: "https://github.com/harbor-framework/terminal-bench-2-1.git",
    commit: "320a8be8b625ee8eb46481f7a397648d7d085775",
    taskPaths: [
      "cancel-async-tasks",
      "git-multibranch",
      "sanitize-git-repo",
      "log-summary-date-ranges",
    ],
  },
  "deepswe-lean": {
    name: "deepswe-lean",
    version: "v1",
    repoUrl: "https://github.com/datacurve-ai/deep-swe.git",
    commit: "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea",
    taskPaths: [
      "tasks/dateutil-rfc5545-timezone-interop",
      "tasks/tengo-destructuring-bindings",
      "tasks/testem-per-launcher-reports",
      "tasks/anko-typed-variable-bindings",
      "tasks/sql-formatter-bigquery-pipe-formatting",
      "tasks/sqlite-utils-safe-import-checkpoints",
      "tasks/go-genai-streamed-function-args",
      "tasks/prometheus-typed-label-sorting",
      "tasks/cliffy-config-file-parsing",
      "tasks/returns-validated-error-accumulation",
      "tasks/bandit-incremental-cache-control",
      "tasks/mnamer-daemon-watch-lifecycle",
    ],
    maxAgentTimeoutSec: 1200,
    defaultEnv: {
      GIT_AUTHOR_NAME: "eve-bench",
      GIT_AUTHOR_EMAIL: "eve-bench@localhost",
      GIT_COMMITTER_NAME: "eve-bench",
      GIT_COMMITTER_EMAIL: "eve-bench@localhost",
    },
  },
};

type TomlValue = string | number | boolean | TomlTable | TomlTable[];
type TomlTable = { [key: string]: TomlValue };

function parseTaskToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const lines = source.split(/\r?\n/u);
  let i = 0;

  while (i < lines.length) {
    const rawLine = stripTomlComment(lines[i] ?? "").trim();
    i += 1;
    if (!rawLine) continue;

    if (rawLine.startsWith("[[") && rawLine.endsWith("]]")) {
      const path = rawLine.slice(2, -2).trim().split(".");
      current = ensureArrayTable(root, path);
      continue;
    }

    if (rawLine.startsWith("[") && rawLine.endsWith("]")) {
      const path = rawLine.slice(1, -1).trim().split(".");
      current = ensureTable(root, path);
      continue;
    }

    const eqIndex = rawLine.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = rawLine
      .slice(0, eqIndex)
      .trim()
      .replace(/^["']|["']$/gu, "");
    let valueStr = rawLine.slice(eqIndex + 1).trim();

    if (valueStr.startsWith("[")) {
      while (!isBalancedBrackets(valueStr) && i < lines.length) {
        valueStr += " " + stripTomlComment(lines[i] ?? "").trim();
        i += 1;
      }
      continue;
    }

    const parsed = parseScalarTomlValue(valueStr);
    if (parsed !== undefined) current[key] = parsed;
  }

  return root;
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function isBalancedBrackets(input: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[") depth += 1;
      else if (ch === "]") depth -= 1;
    }
  }
  return depth <= 0;
}

function parseScalarTomlValue(raw: string): string | number | boolean | undefined {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (/^[+-]?\d+(?:\.\d+)?$/u.test(value)) {
    return Number(value);
  }
  return undefined;
}

function ensureTable(root: TomlTable, path: readonly string[]): TomlTable {
  let cursor = root;
  for (const part of path) {
    const key = part.trim().replace(/^["']|["']$/gu, "");
    const existing = cursor[key];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      cursor = existing;
    } else {
      const next: TomlTable = {};
      cursor[key] = next;
      cursor = next;
    }
  }
  return cursor;
}

function ensureArrayTable(root: TomlTable, path: readonly string[]): TomlTable {
  const parent = ensureTable(root, path.slice(0, -1));
  const key = path[path.length - 1]!.trim().replace(/^["']|["']$/gu, "");
  const existing = parent[key];
  const list: TomlTable[] = Array.isArray(existing) ? existing : [];
  if (!Array.isArray(existing)) parent[key] = list;
  const entry: TomlTable = {};
  list.push(entry);
  return entry;
}

function asTable(value: TomlValue | undefined): TomlTable {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asNumber(value: TomlValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function ensureDatasetCheckout(dataset: DatasetName, cacheDir: string): Promise<string> {
  const lock = DATASET_LOCKS[dataset];
  const repoDir = join(cacheDir, "datasets", `${dataset}-${lock.commit.slice(0, 12)}`);
  const marker = join(repoDir, ".ready");
  if (await exists(marker)) {
    return repoDir;
  }

  await mkdir(repoDir, { recursive: true });
  const git = (args: readonly string[]) =>
    execFileAsync("git", [...args], { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 });

  if (!(await exists(join(repoDir, ".git")))) {
    await git(["init", "-q"]);
    await git(["remote", "add", "origin", lock.repoUrl]);
  }
  await git(["fetch", "--depth", "1", "origin", lock.commit]);
  await git(["checkout", "--force", "FETCH_HEAD"]);
  await writeFile(marker, `${lock.commit}\n`);
  return repoDir;
}

export async function loadTaskFromDir(dataset: DatasetName, taskDir: string): Promise<TaskSpec> {
  const lock = DATASET_LOCKS[dataset];
  const name = taskDir.split("/").filter(Boolean).pop()!;
  const tomlPath = join(taskDir, "task.toml");
  const parsed = parseTaskToml(await readFile(tomlPath, "utf8"));

  const agentTable = asTable(parsed.agent);
  const verifierTable = asTable(parsed.verifier);
  const envTable = asTable(parsed.environment);
  const envVarsTable = asTable(envTable.env);

  const rawAgentTimeout = asNumber(agentTable.timeout_sec, 600);
  const agentTimeoutSec =
    lock.maxAgentTimeoutSec !== undefined
      ? Math.min(rawAgentTimeout, lock.maxAgentTimeoutSec)
      : rawAgentTimeout;
  const verifierTimeoutSec = asNumber(verifierTable.timeout_sec, 600);
  const separateVerifier = verifierTable.environment_mode === "separate";

  const env: Record<string, string> = { ...lock.defaultEnv };
  for (const [key, val] of Object.entries(envVarsTable)) {
    if (typeof val === "string") env[key] = val;
  }

  const collectHooks: CollectHook[] = [];
  if (Array.isArray(verifierTable.collect)) {
    for (const item of verifierTable.collect) {
      if (item && typeof item === "object" && typeof item.command === "string") {
        collectHooks.push({
          command: item.command,
          timeoutSec: asNumber(item.timeout_sec, 300),
        });
      }
    }
  }

  const dockerImage = typeof envTable.docker_image === "string" ? envTable.docker_image : undefined;

  return {
    name,
    dataset,
    dir: taskDir,
    instructionPath: join(taskDir, "instruction.md"),
    testsDir: join(taskDir, "tests"),
    environmentDir: join(taskDir, "environment"),
    dockerImage,
    agentTimeoutSec,
    verifierTimeoutSec,
    separateVerifier,
    cpus: Math.max(1, Math.round(asNumber(envTable.cpus, 2))),
    memoryMb: Math.max(512, Math.round(asNumber(envTable.memory_mb, 4096))),
    env,
    collectHooks,
  };
}

export async function loadDatasetTasks(
  dataset: DatasetName,
  cacheDir: string,
  taskFilter?: string,
): Promise<TaskSpec[]> {
  const lock = DATASET_LOCKS[dataset];
  const repoDir = await ensureDatasetCheckout(dataset, cacheDir);
  const wanted = taskFilter
    ? new Set(
        taskFilter
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
    : null;

  const tasks: TaskSpec[] = [];
  for (const relPath of lock.taskPaths) {
    const taskDir = join(repoDir, relPath);
    const task = await loadTaskFromDir(dataset, taskDir);
    if (wanted && !wanted.has(task.name)) continue;
    tasks.push(task);
  }

  if (wanted && tasks.length === 0) {
    throw new Error(`Task filter "${taskFilter}" matched no tasks in ${dataset}.`);
  }
  return tasks;
}
