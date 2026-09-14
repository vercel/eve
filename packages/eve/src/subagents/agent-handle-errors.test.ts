import { describe, expect, it } from "vitest";

import { formatAgentBusyMessage } from "#subagents/agent-handle-errors.js";

describe("formatAgentBusyMessage", () => {
  it.each([
    ["task_123", 'Agent "research" with id "agent-1" is still working on task "task_123".'],
    [
      "workflow-run-1",
      'Agent "research" with id "agent-1" is still working on another invocation.',
    ],
    [undefined, 'Agent "research" with id "agent-1" is still working on another task.'],
  ])("describes owner %s", (ownerId, expected) => {
    expect(formatAgentBusyMessage({ agentId: "agent-1", agentName: "research", ownerId })).toBe(
      expected,
    );
  });
});
