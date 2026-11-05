import { describe, expect, it } from "vitest";

import { agentDefinitionsOf, type AgentContents, settingsOf } from "./agent-definitions.js";
import type { Definition } from "./definition.js";

const definition = (id: string, label = id): Definition => ({ contribute: () => ({}), id, label });

const empty: AgentContents = {
  connections: [],
  definitions: [],
  instructions: [],
  model: [],
  skills: [],
  subagents: [],
  tools: [],
};

const ids = (contents: AgentContents) => agentDefinitionsOf(contents).map(({ id }) => id);
const labels = (contents: AgentContents) => agentDefinitionsOf(contents).map(({ label }) => label);

describe("agentDefinitionsOf", () => {
  it("places each field, and a file's entries, among eve's runtime definitions", () => {
    expect(
      ids({
        connections: [definition("connection::github")],
        definitions: [definition("context:branch")],
        files: {
          dynamicSubagents: [definition("subagent:subagents/research")],
          hooks: [definition("hook:audit")],
          memory: [definition("memory:notes:recall")],
          scheduleTools: [definition("tool::schedule__digest")],
        },
        instructions: [definition("instructions:agent")],
        model: [definition("eve.model"), definition("model:agent")],
        skills: [definition("skill::triage")],
        subagents: [definition("subagent:subagents/reviewer")],
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
      "context:branch",
      "subagent:subagents/research",
      "memory:notes:recall",
      "tool::deploy",
      "subagent:subagents/reviewer",
      "tool::schedule__digest",
      "skill::triage",
      "eve.skills",
      "eve.approvals",
      "eve.builtins",
      "eve.catalog",
      "eve.model.parent",
    ]);
  });

  it("gives a field's definition an earlier one's place when they share an id", () => {
    const contents: AgentContents = {
      ...empty,
      definitions: [definition("sandbox"), definition("tool::bash", "the default bash")],
      tools: [definition("tool::bash", "my bash"), definition("tool::lookup")],
    };
    const own = agentDefinitionsOf(contents).filter(({ id }) => !id.startsWith("eve."));
    expect(own.map(({ label }) => label)).toEqual(["sandbox", "my bash", "tool::lookup"]);
  });

  it("never replaces a file's entries, which keep the name a later tool would offer", () => {
    expect(
      labels({
        ...empty,
        files: {
          dynamicSubagents: [],
          hooks: [],
          memory: [definition("tool::notes", "the memory's tools")],
          scheduleTools: [],
        },
        tools: [definition("tool::notes", "tools/notes.ts")],
      }).filter((label) => label === "the memory's tools" || label === "tools/notes.ts"),
    ).toEqual(["the memory's tools", "tools/notes.ts"]);
  });

  it("puts static instructions in eve's instructions slot, bare or not", () => {
    const staticInstructions = [
      {
        content: "Ship carefully.",
        name: "instructions",
        owner: { kind: "application" },
        role: "system",
      },
    ] as const;
    expect(ids({ ...empty, staticInstructions }).slice(0, 2)).toEqual([
      "eve.instructions",
      "eve.workspace",
    ]);
    expect(ids({ ...empty, bare: true, staticInstructions })).toEqual(["eve.instructions"]);
  });

  it("leaves out eve's runtime definitions when bare", () => {
    expect(
      ids({
        ...empty,
        bare: true,
        model: [definition("model:agent")],
        tools: [definition("tool::x")],
      }),
    ).toEqual(["model:agent", "tool::x"]);
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
