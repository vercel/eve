import { expect, it } from "vitest";

import { pendingTaskToolCalls } from "#execution/tasks/calls.js";

it("reads task_wait's timeoutSeconds as the milliseconds the turn waits", () => {
  const calls = pendingTaskToolCalls([
    {
      content: [
        {
          input: { timeoutSeconds: 90 },
          toolCallId: "wait-1",
          toolName: "eve__task_wait",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
  ]);

  expect(calls).toEqual([{ callId: "wait-1", kind: "eve__task_wait", timeoutMs: 90_000 }]);
});

it("waits 30 minutes for a task_wait that omits its timeout, and as long as an explicit one asks", () => {
  const wait = (id: string, input: object) => ({
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: id, toolName: "eve__task_wait", input }],
  });
  expect(pendingTaskToolCalls([wait("a", {}), wait("b", { timeoutSeconds: 86_400 })])).toEqual([
    { callId: "a", kind: "eve__task_wait", timeoutMs: 1_800_000 },
    { callId: "b", kind: "eve__task_wait", timeoutMs: 86_400_000 },
  ]);
});
