import { describe, expect, it, vi } from "vitest";

import type { EndsTurnTools } from "#harness/model-call/tools.js";
import type { Step } from "#harness/step/context.js";
import { answeredEndingCalls, settleRuntimeWork } from "#harness/step/intake.js";
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
    expect(settled).toEqual({ endsTurn: false, input: { message: "Next?" }, waited: false });
  });
});

describe("answeredEndingCalls", () => {
  const result = (toolCallId: string, toolName: string, type: "text" | "error-text" = "text") => ({
    output: { type, value: "done" },
    toolCallId,
    toolName,
    type: "tool-result" as const,
  });

  it("finds a successful ending call the parked response answered before it parked", () => {
    const suspended = [
      {
        messages: [
          {
            content: [
              result("call-1", "no_reply"),
              result("call-2", "no_reply", "error-text"),
              result("call-3", "post_chart"),
              result("call-4", "browser__close"),
              result("call-5", "no_reply"),
            ],
            role: "tool" as const,
          },
        ],
      },
    ];
    const ending: EndsTurnTools = new Map<string, true | (() => boolean)>([
      ["no_reply", true],
      ["post_chart", () => true],
    ]);

    expect(answeredEndingCalls(suspended, new Set(["call-5"]), ending)).toEqual([
      { failed: false, output: undefined, toolCallId: "call-1", toolName: "no_reply" },
      { failed: true, output: undefined, toolCallId: "call-2", toolName: "no_reply" },
    ]);
  });
});
