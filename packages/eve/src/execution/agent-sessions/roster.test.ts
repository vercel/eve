import { expect, it } from "vitest";

import { compiledAgentRoster } from "#execution/agent-sessions/roster.js";

it("names the agents a call resolves to a remote agent, as its lookup finds them", () => {
  const bundle = {
    subagentRegistry: {
      subagentsByName: new Map([
        ["reviewer", { definition: { kind: "subagent", name: "reviewer" } }],
        ["billing", { definition: { kind: "remote", name: "billing" } }],
        // Shares its name with a dynamic remote agent, and is found first.
        ["finance", { definition: { kind: "subagent", name: "finance" } }],
      ]),
    },
  };
  const selections = {
    "subagents/tenant": { kind: "remote", prepared: { kind: "remote", name: "tenant" } },
    "subagents/helper": { kind: "subagent", prepared: { kind: "subagent", name: "helper" } },
    "subagents/finance": { kind: "remote", prepared: { kind: "remote", name: "finance" } },
    // A dynamic agent the calling turn didn't select.
    "subagents/idle": null,
  };

  const roster = compiledAgentRoster(bundle as never, selections as never);

  expect(roster.remoteAgentNames()).toEqual(["billing", "tenant"]);
});
