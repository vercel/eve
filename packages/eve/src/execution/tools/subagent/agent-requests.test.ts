import { describe, expect, it, vi } from "vitest";

import { applyAgentRequest } from "#execution/tools/subagent/agent-requests.js";
import { startAgentTasks } from "#tasks/owner-body.js";

vi.mock("#tasks/owner-body.js", () => ({ startAgentTasks: vi.fn() }));

describe("workflow-owned agent requests", () => {
  it("starts a task the session owns and records the workflow run as its caller", async () => {
    const cursor = {} as never;
    const input = { message: "Find it", target: "research" };

    await applyAgentRequest(
      {
        ownerId: "workflow-run",
        replyTo: "reply",
        request: { input, invocationId: "nested", kind: "agent-invoke" },
      },
      cursor,
    );

    expect(startAgentTasks).toHaveBeenCalledExactlyOnceWith(cursor, [
      { callId: "nested", input, workflowCaller: { replyTo: "reply", runId: "workflow-run" } },
    ]);
  });
});
