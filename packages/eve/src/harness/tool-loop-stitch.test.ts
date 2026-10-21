import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { stitchUnansweredToolCalls } from "#harness/tool-loop.js";

const call = { type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} } as const;

describe("stitchUnansweredToolCalls", () => {
  it("answers an orphaned call right after its assistant message", () => {
    const out = stitchUnansweredToolCalls([
      { role: "user", content: "hi" },
      { role: "assistant", content: [call] },
      { role: "user", content: "next" },
    ] as ModelMessage[]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(JSON.stringify(out[2])).toContain('"toolCallId":"c1"');
  });

  it("leaves answered calls alone", () => {
    const messages = [
      { role: "assistant", content: [call] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ] as ModelMessage[];
    expect(stitchUnansweredToolCalls(messages)).toEqual(messages);
  });

  it("leaves a call that is waiting on an approval", () => {
    const messages = [
      {
        role: "assistant",
        content: [call, { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" }],
      },
    ] as ModelMessage[];
    expect(stitchUnansweredToolCalls(messages)).toEqual(messages);
  });

  it("answers each parallel orphan in one tool message", () => {
    const second = { ...call, toolCallId: "c2" };
    const out = stitchUnansweredToolCalls([
      { role: "assistant", content: [call, second] },
    ] as ModelMessage[]);
    expect(out).toHaveLength(2);
    expect((out[1]?.content as unknown[]).length).toBe(2);
  });
});
