import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  createInProcessRuntime,
  type InProcessRuntime,
  type InProcessRuntimeOptions,
} from "#execution/in-process/runtime.js";
import { workflowStepBoundary } from "#execution/workflow-host/step-boundary.js";

export function createTestInProcessRuntime(
  config: SessionRuntimeConfig,
  options: InProcessRuntimeOptions = {},
): InProcessRuntime {
  return createInProcessRuntime(config, {
    deliveries: "batched",
    stepBoundary: workflowStepBoundary,
    ...options,
  });
}
