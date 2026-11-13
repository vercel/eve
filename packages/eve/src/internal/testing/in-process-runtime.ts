import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  createInProcessRuntime,
  type InProcessRuntime,
  type InProcessRuntimeOptions,
} from "#execution/in-process/runtime.js";
import { workflowStepBoundary } from "#execution/workflow-host/step-boundary.js";

/**
 * An in-process runtime as strict as Workflow where a test can tell: steps get what Workflow's
 * own serializer hands them, so a payload a deployment couldn't carry fails here too. `options`
 * overrides it.
 */
export function createTestInProcessRuntime(
  config: SessionRuntimeConfig,
  options: InProcessRuntimeOptions = {},
): InProcessRuntime {
  return createInProcessRuntime(config, {
    stepBoundary: workflowStepBoundary,
    ...options,
  });
}
