import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  createInProcessRuntime,
  type InProcessRuntime,
  type InProcessRuntimeOptions,
} from "#execution/in-process/runtime.js";
import { createRestartableInProcessRuntime } from "#internal/testing/restartable-in-process.js";
import { createTestWorldHostRuntime } from "#internal/testing/world-host-runtime.js";
import { workflowStepBoundary } from "#execution/workflow-host/step-boundary.js";

/**
 * An in-process runtime as strict as Workflow where a test can tell: steps get what Workflow's
 * own serializer hands them, so a payload a deployment couldn't carry fails here too, and
 * deliveries made back to back can reach a session together, as they can when Workflow's run
 * starts late. `options` overrides either.
 */
export function createTestInProcessRuntime(
  config: SessionRuntimeConfig,
  options: InProcessRuntimeOptions & { readonly variant?: InProcessVariant } = {},
): InProcessRuntime {
  const { variant = inProcessVariantFromEnv(), ...rest } = options;
  const strict: InProcessRuntimeOptions = {
    deliveries: "batched",
    stepBoundary: workflowStepBoundary,
    ...rest,
  };
  switch (variant) {
    case "memory":
      return createInProcessRuntime(config, strict);
    case "world":
      return createRestartableInProcessRuntime(config, strict);
    case "world-restart":
      return createRestartableInProcessRuntime(config, { ...strict, restartAtRest: true });
    case "world-host":
      return createTestWorldHostRuntime(config, strict);
  }
}

/**
 * How a test's in-process runtime keeps its sessions: in memory (`memory`); on a World in this
 * process's memory (`world`); or on one, restarted each time it comes to rest after progress
 * (`world-restart`), so every session goes on from what the World kept; or on a World host
 * (`world-host`), whose sessions run only in activations its queue delivers.
 */
export type InProcessVariant = "memory" | "world" | "world-restart" | "world-host";

/**
 * The variant `EVE_TEST_IN_PROCESS_VARIANT` names, which runs every in-process session test on
 * it without changing the tests; `memory` without it.
 */
export function inProcessVariantFromEnv(): InProcessVariant {
  const named = process.env.EVE_TEST_IN_PROCESS_VARIANT;
  if (named === undefined || named === "" || named === "memory") return "memory";
  if (named === "world" || named === "world-restart" || named === "world-host") return named;
  throw new Error(
    `EVE_TEST_IN_PROCESS_VARIANT must be memory, world, world-restart or world-host, not "${named}".`,
  );
}
