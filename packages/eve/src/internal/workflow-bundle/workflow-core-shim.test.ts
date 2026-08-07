import { afterEach, describe, expect, it, vi } from "vitest";

import { sleep } from "#internal/workflow-bundle/workflow-core-shim.js";

const WORKFLOW_SLEEP = Symbol.for("WORKFLOW_SLEEP");
const workflowGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
const originalSleep = workflowGlobal[WORKFLOW_SLEEP];

afterEach(() => {
  if (originalSleep === undefined) {
    delete workflowGlobal[WORKFLOW_SLEEP];
  } else {
    workflowGlobal[WORKFLOW_SLEEP] = originalSleep;
  }
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
