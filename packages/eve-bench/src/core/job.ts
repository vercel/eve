import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DatasetLock } from "./dataset.ts";
import { assertDockerAvailable, listRunnerContainers, removeRunnerContainers } from "./docker.ts";
import type { Harness } from "./harness.ts";
import { summarize, type JobResult, type TrialResult } from "./result.ts";
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
  await assertDockerAvailable();
  const leftovers = await listRunnerContainers({ job: input.name });
  if (leftovers.length > 0) {
    await removeRunnerContainers({ job: input.name });
    for (const container of leftovers) {
      input.onLog?.(`Removed leftover container ${container.name} from job ${input.name}`);
    }
  }
  await mkdir(input.dir, { recursive: true });
  const bundle = await input.harness.prepare({ model: input.model, cacheDir: input.cacheDir });
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
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  const queue = input.tasks.flatMap((task) =>
    Array.from({ length: input.attempts }, (_, index) => ({ task, attempt: index + 1 })),
  );
  const trials: TrialResult[] = [];
  const workers = Array.from({ length: Math.max(1, input.concurrency) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next || input.signal.aborted) return;
      const dir = join(input.dir, next.task.name, String(next.attempt));
      const existing = await readTrial(dir);
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

async function readTrial(dir: string): Promise<TrialResult | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "trial.json"), "utf8")) as TrialResult;
  } catch {
    return undefined;
  }
}
