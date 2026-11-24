import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  createInProcessRuntime,
  type InProcessRuntime,
  type InProcessRuntimeOptions,
} from "#execution/in-process/runtime.js";
import { testEntities } from "#internal/testing/test-platform.js";
import { workflowStepBoundary } from "#execution/workflow-host/step-boundary.js";

export function createTestInProcessRuntime(
  config: SessionRuntimeConfig,
  options: Partial<InProcessRuntimeOptions> = {},
): InProcessRuntime {
  return createInProcessRuntime(config, {
    platform: testEntities(),
    deliveries: "batched",
    stepBoundary: workflowStepBoundary,
    ...options,
  });
}
