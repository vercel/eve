import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { DatasetLock } from "./dataset.ts";
import type { Task } from "./task.ts";

export interface JobIdentity {
  readonly version: 1;
  readonly job: string;
  readonly harness: string;
  readonly model: string;
  readonly attempts: number;
  readonly dataset: string;
  readonly tasks: string;
  readonly provenance: string;
}

export function identityHash(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return item;
  });
  if (json === undefined) throw new Error("Job identity must be JSON serializable.");
  return createHash("sha256").update(json).digest("hex");
}

export function createJobIdentity(input: {
  readonly name: string;
  readonly harness: string;
  readonly model: string;
  readonly attempts: number;
  readonly dataset: DatasetLock;
  readonly tasks: readonly { readonly name: string; readonly hash: string }[];
  readonly provenance?: Record<string, unknown>;
}): JobIdentity {
  const { name, version, gitUrl, commit } = input.dataset;
  const tasks = [...input.tasks].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (new Set(tasks.map((task) => task.name)).size !== tasks.length) {
    throw new Error("Selected task names must be unique to resume safely.");
  }
  return {
    version: 1,
    job: input.name,
    harness: input.harness,
    model: input.model,
    attempts: input.attempts,
    dataset: identityHash({ name, version, gitUrl, commit }),
    tasks: identityHash(tasks),
    provenance: identityHash(input.provenance ?? {}),
  };
}

export function assertJobIdentity(saved: unknown, expected: JobIdentity): void {
  if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 1) {
    throw new Error(
      `Job ${expected.job} has no supported resume identity. Use a new job name; legacy jobs cannot be resumed safely.`,
    );
  }
  const fields = Object.keys(expected) as (keyof JobIdentity)[];
  const changed = fields.filter(
    (key) => !(key in saved) || Reflect.get(saved, key) !== expected[key],
  );
  if (changed.length > 0) {
    throw new Error(
      `Job ${expected.job} resume identity differs (${changed.join(", ")}). Use a new job name for changed inputs.`,
    );
  }
}

/** Hash only the selected tree, independent of its location, mtimes, and traversal order. */
export async function hashTask(task: Task): Promise<string> {
  const dockerfileDir = relative(task.dir, task.environment.dockerfileDir);
  if (isAbsolute(dockerfileDir) || dockerfileDir === ".." || dockerfileDir.startsWith(`..${sep}`)) {
    throw new Error(`Task ${task.name}: environment must be inside the selected task tree.`);
  }
  const entries: { path: string; kind: string; executable: number; hash?: string }[] = [];
  let bytes = 0;
  let count = 0;
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > 64 || ++count > 100_000) {
      throw new Error(`Task ${task.name}: identity scan exceeds 64 levels or 100,000 entries.`);
    }
    const absolute = join(task.dir, path);
    const stat = await lstat(absolute);
    // Do not follow links into unselected tasks (or hash a link but execute its changed target).
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(
        `Task ${task.name}: identity requires regular files/directories, not ${path || "."}.`,
      );
    }
    const entry = {
      path: path.split(sep).join("/"),
      kind: stat.isDirectory() ? "directory" : "file",
      executable: stat.mode & 0o111,
    };
    if (stat.isDirectory()) {
      entries.push(entry);
      for await (const child of await opendir(absolute)) {
        await visit(join(path, child.name), depth + 1);
      }
    } else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024 * 1024) {
          throw new Error(`Task ${task.name}: identity scan exceeds 1 GiB.`);
        }
        hash.update(chunk);
      }
      entries.push({ ...entry, hash: hash.digest("hex") });
    }
  }
  await visit("", 0);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return identityHash({
    entries,
    instruction: task.instruction,
    agentTimeoutMs: task.agentTimeoutMs,
    verifierTimeoutMs: task.verifierTimeoutMs,
    buildTimeoutMs: task.buildTimeoutMs,
    environment: { ...task.environment, dockerfileDir: dockerfileDir.split(sep).join("/") },
  });
}
