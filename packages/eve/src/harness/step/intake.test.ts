import { describe, expect, it, vi } from "vitest";

import type { Step } from "#harness/step/context.js";
import { settleRuntimeWork } from "#harness/step/intake.js";
import type { HarnessSession, HarnessStepInput } from "#harness/types.js";

describe("settleRuntimeWork", () => {
  it("records what a call's agent spent after nothing waits on the call any more", async () => {
    const publish = vi.fn(async () => {});
    // The step only publishes on this path: nothing waits on the session's calls.
    const session = { state: undefined } as Partial<HarnessSession> as HarnessSession;
    const step = { publish, session } as Partial<Step> as Step;
    const spent = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 90, outputTokens: 9 };
    const input = {
      delegatedUsage: { "call-1": spent },
      message: "Next?",
    } as HarnessStepInput;

    const settled = await settleRuntimeWork(step, input);

    expect(publish).toHaveBeenCalledWith([
      { data: { kind: "delegated-late", usage: spent }, type: "usage.recorded" },
    ]);
    expect(settled).toEqual({ input: { message: "Next?" }, waited: false });
  });
});
