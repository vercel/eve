import { beforeEach, expect, it, vi } from "vitest";

import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import { settleTaskAgentInvocationStep } from "#execution/tools/subagent/invoke-step.js";
import { emitTaskSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";

vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  dispatchTaskAgentInvocationStep: vi.fn(),
  settleTaskAgentInvocationStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/emit-event-step.js", () => ({
  emitTaskSubagentEventStep: vi.fn(),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

it.each([
  { accepted: true, emitCompletion: true, isError: false, expected: 1 },
  { accepted: false, emitCompletion: true, isError: false, expected: 0 },
  { accepted: true, emitCompletion: true, isError: true, expected: 0 },
  { accepted: true, emitCompletion: false, isError: false, expected: 0 },
])(
  "emits only accepted nested successes: %j",
  async ({ accepted, emitCompletion, isError, expected }) => {
    const sessionState = {} as never;
    vi.mocked(settleTaskAgentInvocationStep).mockResolvedValue({ accepted, sessionState });
    vi.mocked(emitTaskSubagentEventStep).mockResolvedValue({
      serializedContext: { emitted: true },
    });

    const applied = await applyTaskAgentRequest(
      {
        ownerId: "code-mode-run",
        replyTo: "nested-reply",
        emitCompletion,
        request: {
          kind: "agent-settled",
          result: {
            callId: "program:0",
            kind: "subagent-result",
            origin: "child",
            subagentName: "marker",
            output: { marker: "done" },
            isError,
            outcome: {
              kind: "parked",
              result: { kind: "succeeded", output: { marker: "done" } },
              usageDelta: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            },
          },
        },
      },
      { parentWritable: new WritableStream(), serializedContext: {}, sessionState },
    );

    expect(emitTaskSubagentEventStep).toHaveBeenCalledTimes(expected);
    if (expected === 1) {
      expect(emitTaskSubagentEventStep).toHaveBeenCalledWith(
        expect.objectContaining({
          event: {
            type: "subagent.completed",
            data: { callId: "program:0", subagentName: "marker", output: '{"marker":"done"}' },
          },
        }),
      );
      expect(applied.serializedContext).toEqual({ emitted: true });
    }
  },
);
