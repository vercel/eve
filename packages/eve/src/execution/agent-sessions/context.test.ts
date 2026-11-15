import { expect, it, vi } from "vitest";

import { captureAgentSessionContext } from "#execution/agent-sessions/context.js";

it("records the remote agents the owner's roster names for the call's dynamic selections", () => {
  const selections = { "subagents/tenant": null };
  const roster = vi.fn(() => ({ remoteAgentNames: () => ["billing"] }));

  const context = captureAgentSessionContext(
    {
      batch: { event: { sequence: 1, turnId: "turn-1" } },
      dynamicSubagentSelections: selections,
      owner: { reference: { kind: "bundle", source: {} }, roster },
      sandboxSessionId: "session",
      serializedContext: {},
      session: { sessionId: "session" },
      workflowAgents: {},
    } as never,
    "call-1",
  );

  expect(context.remoteAgents).toEqual(["billing"]);
  expect(roster).toHaveBeenCalledExactlyOnceWith(selections);
});
