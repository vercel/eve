import { describe, expect, it } from "vitest";

import { agentDefinitionsOf, type AgentContents, settingsOf } from "./agent-definitions.js";
import type { Definition } from "./definition.js";

const definition = (id: string, label = id): Definition => ({ contribute: () => ({}), id, label });

const ids = (contents: AgentContents) => agentDefinitionsOf(contents).map(({ id }) => id);

describe("agentDefinitionsOf", () => {
  it("places each kind of file among eve's runtime definitions", () => {
    expect(
      ids({
        connections: [definition("connection::github")],
        files: {
          dynamicSubagents: [definition("subagent:subagents/research")],
          hooks: [definition("hook:audit")],
          memory: [definition("memory:notes:recall")],
          scheduleTools: [definition("tool::schedule__digest")],
        },
        instructions: [definition("instructions:agent")],
        model: [definition("eve.model"), definition("model:agent")],
        skills: [definition("skill::triage")],
        tools: [definition("tool::deploy")],
      }),
    ).toEqual([
      "hook:audit",
      "eve.model",
      "model:agent",
      "eve.instructions",
      "instructions:agent",
      "eve.workspace",
      "eve.connections",
      "connection::github",
      "eve.tools",
      "subagent:subagents/research",
      "memory:notes:recall",
      "tool::deploy",
      "tool::schedule__digest",
      "skill::triage",
      "eve.skills",
      "eve.approvals",
      "eve.builtins",
      "eve.catalog",
      "eve.model.parent",
    ]);
  });
});

describe("settingsOf", () => {
  it("reads the usage limit once, when a turn first asks, and turns `false` off", async () => {
    let reads = 0;
    const settings = settingsOf({
      sessionUsage: () => {
        reads += 1;
        return false;
      },
    });
    expect(reads).toBe(0);
    expect(await settings.limits?.sessionUsage?.({} as never)).toBe(false);
    expect(settings.limits?.sessionUsage).toBe(settings.limits?.sessionUsage);
    expect(reads).toBe(1);
  });
});
