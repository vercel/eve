import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createActiveStepAbortController,
  sleep,
} from "#internal/workflow-bundle/workflow-core-shim.js";

const WORKFLOW_CREATE_ACTIVE_STEP_ABORT_CONTROLLER = Symbol.for(
  "WORKFLOW_CREATE_ACTIVE_STEP_ABORT_CONTROLLER",
);
const WORKFLOW_SLEEP = Symbol.for("WORKFLOW_SLEEP");
const workflowGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
const originalCreateActiveStepAbortController =
  workflowGlobal[WORKFLOW_CREATE_ACTIVE_STEP_ABORT_CONTROLLER];
const originalSleep = workflowGlobal[WORKFLOW_SLEEP];

afterEach(() => {
  if (originalSleep === undefined) {
    delete workflowGlobal[WORKFLOW_SLEEP];
  } else {
    workflowGlobal[WORKFLOW_SLEEP] = originalSleep;
  }
  if (originalCreateActiveStepAbortController === undefined) {
    delete workflowGlobal[WORKFLOW_CREATE_ACTIVE_STEP_ABORT_CONTROLLER];
  } else {
    workflowGlobal[WORKFLOW_CREATE_ACTIVE_STEP_ABORT_CONTROLLER] =
      originalCreateActiveStepAbortController;
  }
});

describe("workflow core shim active-step abort controller", () => {
  it("forwards a deterministic cancellation token to the workflow VM", () => {
    const controller = {
      dispose: vi.fn(),
      signal: new AbortController().signal,
      token: "abrt_turn",
    };
    const createController = vi.fn(() => controller);
    workflowGlobal[WORKFLOW_CREATE_ACTIVE_STEP_ABORT_CONTROLLER] = createController;

    expect(createActiveStepAbortController({ token: "abrt_turn" })).toBe(controller);
    expect(createController).toHaveBeenCalledExactlyOnceWith({ token: "abrt_turn" });
  });
});

describe("workflow core shim sleep", () => {
  it("forwards durable durations to the workflow VM implementation", async () => {
    const sleepImpl = vi.fn(async () => {});
    workflowGlobal[WORKFLOW_SLEEP] = sleepImpl;

    await expect(sleep(2_500)).resolves.toBeUndefined();
    expect(sleepImpl).toHaveBeenCalledExactlyOnceWith(2_500);
  });

  it("rejects use outside a workflow body", () => {
    delete workflowGlobal[WORKFLOW_SLEEP];

    expect(() => sleep(2_500)).toThrow("`sleep()` can only be called inside a workflow function");
  });
});
