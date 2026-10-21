import { beforeEach, describe, expect, it, vi } from "vitest";

import { FatalError, RetryableError } from "#compiled/@workflow/core/index.js";
import {
  RunConcurrencyError,
  RunCpuTimeoutError,
  RunDetachedBridgeRequestError,
  RunError,
} from "#compiled/run/index.js";

const run = vi.fn();
vi.mock("#shared/workflow-sandbox.js", () => ({
  loadWorkflowSandboxModule: async () => ({
    RunError,
    createRunner: () => ({ run }),
    createSignedContinuationCodec: () => ({}),
    getHostFunctionContext: () => ({}),
  }),
}));

import { runWorkflowProgramStep } from "#execution/dynamic-workflow/program-step.js";

const step = () =>
  runWorkflowProgramStep({
    callId: "call",
    program: { continuationSecurity: { signingKey: "key" }, js: "return 1;", maxSubagents: 1 },
  });

describe("runWorkflowProgramStep failures", () => {
  beforeEach(() => vi.resetAllMocks());

  it("retries when run has no free worker", async () => {
    run.mockRejectedValue(new RunConcurrencyError(4));

    const error = await step().catch((caught: unknown) => caught);
    expect(RetryableError.is(error)).toBe(true);
    expect(FatalError.is(error)).toBe(false);
    expect((error as RetryableError).message).toBe(
      "JavaScript runtime maxWorkers limit reached (4).",
    );
    expect((error as RetryableError).retryAfter.getTime()).toBeGreaterThan(Date.now() + 4_000);
  });

  it("keeps other run failures fatal", async () => {
    run.mockRejectedValue(new RunCpuTimeoutError(30_000));
    const cpu = await step().catch((caught: unknown) => caught);
    expect(FatalError.is(cpu)).toBe(true);
    expect((cpu as FatalError).message).toBe(
      "JavaScript runtime exceeded its CPU time limit of 30000ms.",
    );

    run.mockRejectedValue(new RunError("Continuation signature is invalid.", "RUN_PROTOCOL_ERROR"));
    const protocol = await step().catch((caught: unknown) => caught);
    expect(FatalError.is(protocol)).toBe(true);
    expect(RetryableError.is(protocol)).toBe(false);
  });

  it("explains an un-awaited ctx.agent call without run's internal names", async () => {
    run.mockRejectedValue(
      new RunDetachedBridgeRequestError(
        "JavaScript runtime returned while a hostFunction bridge request was still pending: __eveWorkflowProgram.agent.",
      ),
    );

    const error = await step().catch((caught: unknown) => caught);
    expect(FatalError.is(error)).toBe(true);
    expect((error as FatalError).message).toBe(
      "Workflow program returned while a ctx.agent() call was still pending. Await every ctx.agent() call before returning, including calls passed to Promise.race or Promise.any.",
    );
  });
});
