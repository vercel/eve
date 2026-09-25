import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatasetLock } from "./dataset.ts";
import { assertDockerAvailable, listRunnerContainers, removeRunnerContainers } from "./docker.ts";
import type { Harness } from "./harness.ts";
import { assertSafeId } from "./id.ts";
import { assertJobIdentity, createJobIdentity, hashTask, identityHash } from "./job-identity.ts";
import { assertTrialResult, summarize, type JobResult, type TrialResult } from "./result.ts";
import type { Task } from "./task.ts";
import { runTrial } from "./trial.ts";

export interface JobInput {
  readonly name: string;
  readonly dir: string;
  readonly cacheDir: string;
  readonly dataset: DatasetLock;
  readonly tasks: readonly Task[];
  readonly harness: Harness;
  readonly model: string;
  readonly attempts: number;
  readonly concurrency: number;
  readonly forwardEnv: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly onLog?: (message: string) => void;
  readonly onTrial?: (trial: TrialResult, resumed: boolean) => void;
}

export async function runJob(input: JobInput): Promise<JobResult> {
  assertSafeId(input.name, "job");
  for (const task of input.tasks) assertSafeId(task.name, "task");
  // Containers are labeled by name, so different output directories must share the lock.
  const lockPath = join(tmpdir(), `eve-bench-job-${identityHash(input.name)}.lock`);
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `Job ${input.name} is locked. Wait for the active run or use a new job name. If the owner crashed, confirm it has stopped before removing ${lockPath}.`,
    );
  });
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, job: input.name })}\n`);
    return await runLockedJob(input);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function runLockedJob(input: JobInput): Promise<JobResult> {
  await mkdir(input.dir, { recursive: true });
  const savedIdentity = await readSavedIdentity(input.dir, input.name);
  const taskHashes = [];
  for (const task of input.tasks) taskHashes.push({ name: task.name, hash: await hashTask(task) });
  const bundle = await input.harness.prepare({ model: input.model, cacheDir: input.cacheDir });
  const identity = createJobIdentity({
    ...input,
    harness: input.harness.name,
    tasks: taskHashes,
    provenance: bundle.provenance,
  });
  if (savedIdentity !== undefined) assertJobIdentity(savedIdentity, identity);

  await assertDockerAvailable();
  const leftovers = await listRunnerContainers({ job: input.name });
  if (savedIdentity === undefined && leftovers.length > 0) {
    throw new Error(
      `Job ${input.name} has containers but no resume identity here. Use a new job name or resume from the original job directory.`,
    );
  }
  if (savedIdentity === undefined) {
    await writeFile(
      join(input.dir, "job.json"),
      `${JSON.stringify(
        {
          job: input.name,
          dataset: {
            name: input.dataset.name,
            version: input.dataset.version,
            commit: input.dataset.commit,
          },
          harness: input.harness.name,
          model: input.model,
          attempts: input.attempts,
          tasks: input.tasks.map((task) => task.name),
          bundle: bundle.provenance ?? {},
          identity,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
  }
  if (leftovers.length > 0) {
    await removeRunnerContainers({ job: input.name });
    for (const container of leftovers) {
      input.onLog?.(`Removed leftover container ${container.name} from job ${input.name}`);
    }
  }

  const queue = input.tasks.flatMap((task) =>
    Array.from({ length: input.attempts }, (_, index) => ({ task, attempt: index + 1 })),
  );
  const trials: TrialResult[] = [];
  const workers = Array.from({ length: Math.max(1, input.concurrency) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next || input.signal.aborted) return;
      const dir = join(input.dir, next.task.name, String(next.attempt));
      const existing = await readTrial(dir, {
        task: next.task.name,
        attempt: next.attempt,
        harness: input.harness.name,
        model: input.model,
      });
      if (existing) {
        trials.push(existing);
        input.onTrial?.(existing, true);
        continue;
      }
      const trial = await runTrial({
        task: next.task,
        attempt: next.attempt,
        harness: input.harness,
        bundle,
        model: input.model,
        forwardEnv: input.forwardEnv,
        job: input.name,
        dir,
        signal: input.signal,
      });
      trials.push(trial);
      input.onTrial?.(trial, false);
    }
  });
  const outcomes = await Promise.allSettled(workers);
  if (input.signal.aborted) await removeRunnerContainers({ job: input.name });
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason;
  }

  trials.sort((a, b) => a.task.localeCompare(b.task) || a.attempt - b.attempt);
  const result: JobResult = {
    job: input.name,
    dataset: {
      name: input.dataset.name,
      version: input.dataset.version,
      commit: input.dataset.commit,
    },
    harness: input.harness.name,
    model: input.model,
    trials,
    summary: summarize(trials),
  };
  await writeFile(join(input.dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function readJobResult(dir: string): Promise<JobResult> {
  return JSON.parse(await readFile(join(dir, "result.json"), "utf8")) as JobResult;
}

async function readSavedIdentity(dir: string, name: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(join(dir, "job.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if ((await readdir(dir)).length === 0) return undefined;
    throw new Error(
      `Job ${name} has existing files but no job.json. Use a new job name to run safely.`,
    );
  }
  let saved;
  try {
    saved = JSON.parse(text);
  } catch {
    throw new Error(`Job ${name} has invalid job.json. Use a new job name to run safely.`);
  }
  if (saved?.identity?.version !== 1) {
    throw new Error(
      `Job ${name} has no supported resume identity. Use a new job name; legacy jobs cannot be resumed safely.`,
    );
  }
  return saved.identity;
}

async function readTrial(
  dir: string,
  expected: Pick<TrialResult, "task" | "attempt" | "harness" | "model">,
): Promise<TrialResult | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "trial.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Trial ${expected.task}#${expected.attempt} has invalid JSON; remove the job or use a new job name.`,
    );
  }
  assertTrialResult(parsed);
  for (const key of ["task", "attempt", "harness", "model"] as const) {
    if (parsed[key] !== expected[key]) {
      throw new Error(
        `Trial ${expected.task}#${expected.attempt} has mismatched ${key}; use a new job name.`,
      );
    }
  }
  return parsed;
}
