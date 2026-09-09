import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { parseToml, type TomlTable } from "./toml.ts";

export interface Task {
  readonly name: string;
  readonly dir: string;
  readonly instruction: string;
  readonly agentTimeoutMs: number;
  readonly verifierTimeoutMs: number;
  readonly buildTimeoutMs: number;
  readonly environment: {
    readonly dockerImage?: string;
    readonly dockerfileDir: string;
    readonly cpus?: number;
    readonly memoryMb?: number;
    readonly allowInternet: boolean;
  };
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export async function loadTask(dir: string): Promise<Task> {
  const toml = parseToml(await readFile(join(dir, "task.toml"), "utf8"));
  const instruction = await readFile(join(dir, "instruction.md"), "utf8");
  await access(join(dir, "tests", "test.sh"));
  const task = table(toml, "task");
  const agent = table(toml, "agent");
  const verifier = table(toml, "verifier");
  const environment = table(toml, "environment");
  const dockerImage = str(environment, "docker_image");
  const dockerfileDir = join(dir, "environment");
  if (dockerImage === undefined) await access(join(dockerfileDir, "Dockerfile"));
  return {
    name: shortName(str(task, "name") ?? basename(dir)),
    dir,
    instruction,
    agentTimeoutMs: seconds(agent, "timeout_sec"),
    verifierTimeoutMs: seconds(verifier, "timeout_sec"),
    buildTimeoutMs: seconds(environment, "build_timeout_sec"),
    environment: {
      dockerImage,
      dockerfileDir,
      cpus: num(environment, "cpus"),
      memoryMb: num(environment, "memory_mb") ?? memoryMb(str(environment, "memory")),
      allowInternet: environment.allow_internet !== false,
    },
  };
}

function shortName(name: string): string {
  return name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
}

function table(root: TomlTable, key: string): TomlTable {
  const value = root[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function str(table: TomlTable, key: string): string | undefined {
  const value = table[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(table: TomlTable, key: string): number | undefined {
  const value = table[key];
  return typeof value === "number" ? value : undefined;
}

/** Older tasks declare `memory = "2G"` instead of `memory_mb`. */
function memoryMb(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d+(?:\.\d+)?)\s*([GgMm])/u);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Math.round(match[2]!.toLowerCase() === "g" ? amount * 1024 : amount);
}

function seconds(table: TomlTable, key: string): number {
  const value = num(table, key);
  return value === undefined ? DEFAULT_TIMEOUT_MS : Math.round(value * 1000);
}
