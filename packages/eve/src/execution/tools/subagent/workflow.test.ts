import { describe, expect, it, vi } from "vitest";

import { invokeAgent } from "eve/workflow";
import { subagentToolExecuteWorkflow } from "./workflow.js";

vi.mock("eve/workflow", () => ({ invokeAgent: vi.fn() }));

describe("subagentToolExecuteWorkflow", () => {
  it("derives the subagent target from the workflow tool name", async () => {
    vi.mocked(invokeAgent).mockResolvedValue("done");

    await expect(
      subagentToolExecuteWorkflow({ agentId: "agent-1", message: "Find it" }, {
        toolName: "research",
        callId: "call-1",
      } as never),
    ).resolves.toBe("done");
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "research" }),
      {
        agentId: "agent-1",
        message: "Find it",
        target: "research",
      },
      { invocationId: "call-1" },
    );
  });

  it("normalizes an omitted continuation id inside the workflow body", async () => {
    vi.mocked(invokeAgent).mockResolvedValue("done");

    await subagentToolExecuteWorkflow(
      { agentId: null, message: "Start fresh", outputSchema: { type: "object" } },
      { callId: "call-1", toolName: "research" } as never,
    );

    expect(invokeAgent).toHaveBeenCalledWith(
      expect.anything(),
      {
        message: "Start fresh",
        outputSchema: { type: "object" },
        target: "research",
      },
      { invocationId: "call-1" },
    );
  });
});
