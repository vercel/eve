import type { Nitro } from "nitro/types";

import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";

/**
 * Virtual id prefix used for the synthetic Nitro task module emitted for each
 * eve authored schedule. Each registered task points at its own virtual id so
 * Rollup can resolve the generated `defineTask({...})` source without writing
 * a physical handler file.
 */
const EVE_SCHEDULE_TASK_VIRTUAL_ID_PREFIX = "#eve-schedule-task/";

interface ScheduleTaskNitro {
  options: Pick<Nitro["options"], "experimental" | "scheduledTasks" | "tasks" | "virtual">;
}

/**
 * Inputs needed to wire one set of compiled authored schedules into Nitro's
 * task and cron surfaces.
 *
 * `dispatchModulePath` is the absolute path of `dispatchScheduleTask`'s
 * module — the synthetic task module imports it and forwards `event.name`
 * along with the baked-in artifacts config.
 */
interface RegisterScheduleTaskHandlersInput {
  readonly artifactsConfig: NitroArtifactsConfig;
  readonly dispatchModulePath: string;
  readonly registrations: readonly ScheduleRegistration[];
}

/**
 * Registers compiled authored schedules as virtual Nitro task handlers.
 *
 * Each registration becomes:
 *   - one entry in `nitro.options.tasks` whose `handler` points at a virtual
 *     module that wraps `dispatchScheduleTask` in `defineTask({...})`,
 *   - one entry in `nitro.options.scheduledTasks[cron]` so Nitro's cron
 *     scheduler dispatches the task on schedule.
 *
 * The synthetic module is needed because Nitro requires task modules to
 * default-export an object with a `run` method. The dispatch implementation
 * (`dispatchScheduleTask`) is a plain async function — the virtual module
 * adapts it to Nitro's task contract while baking in the artifacts config so
 * the handler does not depend on a global runtime configuration store.
 */
export function registerScheduleTaskHandlers(
  nitro: ScheduleTaskNitro,
  input: RegisterScheduleTaskHandlersInput,
): void {
  if (input.registrations.length === 0) {
    return;
  }

  nitro.options.experimental.tasks = true;

  for (const registration of input.registrations) {
    addScheduleTaskVirtualHandler(nitro, {
      artifactsConfig: input.artifactsConfig,
      dispatchModulePath: input.dispatchModulePath,
      registration,
    });
  }
}

function addScheduleTaskVirtualHandler(
  nitro: ScheduleTaskNitro,
  input: {
    artifactsConfig: NitroArtifactsConfig;
    dispatchModulePath: string;
    registration: ScheduleRegistration;
  },
): void {
  addVirtualScheduledTask(nitro, {
    artifactsConfig: input.artifactsConfig,
    cron: input.registration.cron,
    description: input.registration.description,
    importLine: `import { dispatchScheduleTask } from ${stringifyEsmImportSpecifier(input.dispatchModulePath)};`,
    runExpression: "dispatchScheduleTask(event.name, config)",
    taskName: input.registration.taskName,
  });
}

/** Weekly, Sundays 04:17 UTC. */
const TOOL_SESSION_SANDBOX_SWEEP_CRON = "17 4 * * 0";
const TOOL_SESSION_SANDBOX_SWEEP_TASK_NAME = "eve.tool-session-sandbox-sweep";

/**
 * Registers the framework's weekly task that deletes idle tool-session
 * sandboxes, beside the authored schedules. `sweepModulePath` is the module
 * exporting `runToolSessionSandboxSweepTask`.
 */
export function registerToolSessionSandboxSweepTask(
  nitro: ScheduleTaskNitro,
  input: { readonly artifactsConfig: NitroArtifactsConfig; readonly sweepModulePath: string },
): void {
  nitro.options.experimental.tasks = true;
  addVirtualScheduledTask(nitro, {
    artifactsConfig: input.artifactsConfig,
    cron: TOOL_SESSION_SANDBOX_SWEEP_CRON,
    description: "Delete idle tool-session sandboxes.",
    importLine: `import { runToolSessionSandboxSweepTask } from ${stringifyEsmImportSpecifier(input.sweepModulePath)};`,
    runExpression: "runToolSessionSandboxSweepTask(config)",
    taskName: TOOL_SESSION_SANDBOX_SWEEP_TASK_NAME,
  });
}

/**
 * Adds one cron-triggered task whose handler is a virtual module: `importLine`
 * brings in the function `runExpression` calls, with `config` (the artifacts
 * config) and `event` in scope.
 *
 * The module exports a plain task object rather than using Nitro's
 * `defineTask`, which is a passthrough that only installs a guard `run` when
 * one is missing. Importing from `"nitro/task"` would fail at runtime on
 * Vercel because `nitro` is a build-only dependency and is not included in
 * the deployed function trace.
 */
function addVirtualScheduledTask(
  nitro: ScheduleTaskNitro,
  input: {
    readonly artifactsConfig: NitroArtifactsConfig;
    readonly cron: string;
    readonly description: string;
    readonly importLine: string;
    readonly runExpression: string;
    readonly taskName: string;
  },
): void {
  const virtualId = `${EVE_SCHEDULE_TASK_VIRTUAL_ID_PREFIX}${input.taskName}`;
  nitro.options.tasks[input.taskName] = { description: input.description, handler: virtualId };
  nitro.options.virtual[virtualId] = [
    input.importLine,
    `const config = ${JSON.stringify(input.artifactsConfig)};`,
    `export default {`,
    `  meta: { description: ${JSON.stringify(input.description)} },`,
    `  async run(event) {`,
    `    return { result: await ${input.runExpression} };`,
    `  },`,
    `};`,
  ].join("\n");
  appendScheduledTask(nitro, input.cron, input.taskName);
}

function appendScheduledTask(nitro: ScheduleTaskNitro, cron: string, taskName: string): void {
  const existingScheduleTasks = nitro.options.scheduledTasks[cron];

  if (existingScheduleTasks === undefined) {
    nitro.options.scheduledTasks[cron] = taskName;
    return;
  }

  if (typeof existingScheduleTasks === "string") {
    nitro.options.scheduledTasks[cron] = [existingScheduleTasks, taskName];
    return;
  }

  if (!existingScheduleTasks.includes(taskName)) {
    existingScheduleTasks.push(taskName);
  }
}
