import { expect, it } from "vitest";

import { captureAgentSessionContext } from "#execution/agent-sessions/context.js";
import { compiledAgentRoster } from "#execution/agent-sessions/roster.js";

it("lists a dynamic remote agent the calling turn selected among the call's remote agents", () => {
  const bundle = { subagentRegistry: { subagentsByName: new Map() } };
  // The calling turn selected the dynamic remote agent "tenant".
  const selections = {
    "subagents/tenant": { kind: "remote", prepared: { kind: "remote", name: "tenant" } },
  };

  const context = captureAgentSessionContext(
    {
      batch: { event: { sequence: 1, turnId: "turn-1" } },
      dynamicSubagentSelections: selections,
      owner: {
        reference: { kind: "bundle", source: {} },
        roster: (selected: never) => compiledAgentRoster(bundle as never, selected),
      },
      sandboxSessionId: "session",
      serializedContext: {},
      session: { sessionId: "session" },
      workflowAgents: {},
    } as never,
    "call-1",
  );

  expect(context.remoteAgents).toEqual(["tenant"]);
});
