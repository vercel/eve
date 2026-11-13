import {
  dehydrateStepArguments,
  hydrateStepArguments,
} from "#compiled/@workflow/core/serialization.js";
import type { StepBoundary } from "#execution/in-process/step-boundary.js";

const IN_PROCESS_RUN_ID = "in-process";

/**
 * Workflow's own step serializer, for an in-process host that should hand its steps exactly what
 * a deployment would. It's opt-in (`createInProcessRuntime(config, { stepBoundary })`), so the
 * in-process host itself never loads Workflow.
 */
export const workflowStepBoundary: StepBoundary = {
  send: async (value) => ({
    carried: await dehydrateStepArguments(value, IN_PROCESS_RUN_ID, undefined),
  }),
  receive: async ({ carried }) => await hydrateStepArguments(carried, IN_PROCESS_RUN_ID, undefined),
};
