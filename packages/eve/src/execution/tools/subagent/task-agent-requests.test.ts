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
  { accepted: true, taskId: undefined, isError: false, expected: 1 },
  { accepted: false, taskId: undefined, isError: false, expected: 0 },
  { accepted: true, taskId: undefined, isError: true, expected: 0 },
  // A background child's own subagent settles on the child's stream, not here.
  { accepted: true, taskId: "child-task", isError: false, expected: 0 },
])(
  "announces accepted settlements owned by this session: %j",
  async ({ accepted, taskId, isError, expected }) => {
    const sessionState = {} as never;
    vi.mocked(settleTaskAgentInvocationStep).mockResolvedValue({ accepted, sessionState });
    vi.mocked(emitTaskSubagentEventStep).mockResolvedValue({
      serializedContext: { emitted: true },
    });

    const applied = await applyTaskAgentRequest(
      {
        ownerId: "code-mode-run",
        replyTo: "nested-reply",
        taskId,
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
