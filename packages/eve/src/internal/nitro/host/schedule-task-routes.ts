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
  const virtualId = `${EVE_SCHEDULE_TASK_VIRTUAL_ID_PREFIX}${input.registration.taskName}`;
  const dispatchModulePath = stringifyEsmImportSpecifier(input.dispatchModulePath);

  nitro.options.tasks[input.registration.taskName] = {
    description: input.registration.description,
    handler: virtualId,
  };

  // Nitro's `defineTask` is a passthrough that only installs a guard `run`
  // when one is missing — we always provide one, so we skip the import and
  // export the task object directly. Importing from `"nitro/task"` would
  // fail at runtime on Vercel because `nitro` is a build-only dependency
  // and is not included in the deployed function trace.
  nitro.options.virtual[virtualId] = [
    `import { dispatchScheduleTask } from ${dispatchModulePath};`,
    `const config = ${JSON.stringify(input.artifactsConfig)};`,
    `export default {`,
    `  meta: { description: ${JSON.stringify(input.registration.description)} },`,
    `  async run(event) {`,
    `    return { result: await dispatchScheduleTask(event.name, config) };`,
    `  },`,
    `};`,
  ].join("\n");

  appendScheduledTask(nitro, input.registration.cron, input.registration.taskName);
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
