import { expect, it } from "vitest";

import { pendingTaskToolCalls } from "#execution/tasks/calls.js";

it("reads task_wait's timeoutSeconds as the milliseconds the turn waits", () => {
  const calls = pendingTaskToolCalls([
    {
      content: [
        {
          input: { timeoutSeconds: 90 },
          toolCallId: "wait-1",
          toolName: "task_wait",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
  ]);

  expect(calls).toEqual([{ callId: "wait-1", kind: "task_wait", timeoutMs: 90_000 }]);
});
