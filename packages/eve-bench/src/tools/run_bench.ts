import { join } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { syncDataset, taskDirs } from "../core/dataset.ts";
import { runJob } from "../core/job.ts";
import { loadTask } from "../core/task.ts";
import { defaultJobName, forwardedEnv, paths, selectHarness, selectTasks } from "../options.ts";

export const inputSchema = z
  .object({
    cohort: z.string().min(1).optional(),
    tasks: z.array(z.string().min(1)).min(1).optional(),
    model: z.string().min(1).optional(),
    harness: z.enum(["eve", "oracle"]).default("eve"),
    eve: z.string().min(1).default("local"),
    attempts: z.number().int().positive().default(1),
    concurrency: z.number().int().positive().default(4),
    job: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.harness !== "oracle" && !input.model) {
      ctx.addIssue({ code: "custom", path: ["model"], message: "model is required" });
    }
  });

export default defineTool({
  description: "Run an eve benchmark job and return its result.",
  inputSchema,
  async execute(input, ctx) {
    const harness = selectHarness(input.harness, input.eve);
    const model = input.model ?? "none";
    const selection = await selectTasks({ cohort: input.cohort, task: input.tasks });
    const datasetDir = await syncDataset(join(paths.generatedRoot, "datasets"), selection.lock);
    const tasks = await Promise.all(
      (await taskDirs(datasetDir, selection.tasks)).map((dir) => loadTask(dir)),
    );
    const name = input.job ?? defaultJobName(`${harness.name}-${model}`);

    return runJob({
      name,
      dir: join(paths.generatedRoot, "jobs", name),
      cacheDir: join(paths.generatedRoot, "cache"),
      dataset: selection.lock,
      tasks,
      harness,
      model,
      attempts: input.attempts,
      concurrency: input.concurrency,
      forwardEnv: forwardedEnv(),
      signal: ctx.abortSignal,
    });
  },
});
