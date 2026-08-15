import type { Nitro } from "nitro/types";

import {
  EVE_SCHEDULE_TASK_NAME_PREFIX,
  type ScheduleRegistration,
} from "#runtime/schedules/register.js";
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
export interface RegisterScheduleTaskHandlersInput {
  readonly artifactsConfig: NitroArtifactsConfig;
  readonly dispatchModulePath: string;
  readonly registrations: readonly ScheduleRegistration[];
}

/**
 * Inputs needed to reconcile schedule task handlers when authored sources
 * change in dev mode.
 */
export interface SyncScheduleTaskHandlersInput {
  readonly artifactsConfig: NitroArtifactsConfig;
  readonly dispatchModulePath: string;
  readonly next: readonly ScheduleRegistration[];
  readonly previous: readonly ScheduleRegistration[];
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

/**
 * Replaces the currently-registered eve schedule task handlers when the
 * compiled authored schedule set changes.
 *
 * Returns `true` when the registration set changed (and the caller should
 * trigger a Nitro rebuild reload), `false` when it was a structural no-op.
 */
export function syncScheduleTaskHandlers(
  nitro: ScheduleTaskNitro,
  input: SyncScheduleTaskHandlersInput,
): boolean {
  const hasChanged = !areScheduleRegistrationsEqual(input.previous, input.next);

  removeScheduleTaskHandlers(nitro);
  registerScheduleTaskHandlers(nitro, {
    artifactsConfig: input.artifactsConfig,
    dispatchModulePath: input.dispatchModulePath,
    registrations: input.next,
  });

  return hasChanged;
}

/**
 * Removes every eve-owned schedule task entry, virtual handler module, and
 * cron entry from the Nitro options. Used by the dev watcher before
 * re-registering the latest compiled set.
 */
export function removeScheduleTaskHandlers(nitro: ScheduleTaskNitro): void {
  for (const taskName of Object.keys(nitro.options.tasks)) {
    if (taskName.startsWith(EVE_SCHEDULE_TASK_NAME_PREFIX)) {
      delete nitro.options.tasks[taskName];
    }
  }

  for (const virtualId of Object.keys(nitro.options.virtual)) {
    if (virtualId.startsWith(EVE_SCHEDULE_TASK_VIRTUAL_ID_PREFIX)) {
      delete nitro.options.virtual[virtualId];
    }
  }

  for (const [cron, scheduledTask] of Object.entries(nitro.options.scheduledTasks)) {
    const filtered = normalizeScheduledTasks(scheduledTask).filter(
      (taskName) => !taskName.startsWith(EVE_SCHEDULE_TASK_NAME_PREFIX),
    );

    if (filtered.length === 0) {
      delete nitro.options.scheduledTasks[cron];
      continue;
    }

    if (filtered.length === 1) {
      const [singleTask] = filtered;

      if (singleTask !== undefined) {
        nitro.options.scheduledTasks[cron] = singleTask;
      }

      continue;
    }

    nitro.options.scheduledTasks[cron] = filtered;
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

function normalizeScheduledTasks(value: string | string[]): string[] {
  return typeof value === "string" ? [value] : [...value];
}

function areScheduleRegistrationsEqual(
  left: readonly ScheduleRegistration[],
  right: readonly ScheduleRegistration[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftRegistration = left[index];
    const rightRegistration = right[index];

    if (leftRegistration === undefined || rightRegistration === undefined) {
      return false;
    }

    if (
      leftRegistration.cron !== rightRegistration.cron ||
      leftRegistration.description !== rightRegistration.description ||
      leftRegistration.logicalPath !== rightRegistration.logicalPath ||
      leftRegistration.scheduleId !== rightRegistration.scheduleId ||
      leftRegistration.sourceId !== rightRegistration.sourceId ||
      leftRegistration.taskName !== rightRegistration.taskName
    ) {
      return false;
    }
  }

  return true;
}
