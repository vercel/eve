import { describe, expect, it } from "vitest";

import { eve } from "#definitions/defaults.js";
import { codeAgentOf, defineContext } from "#embed/agent.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineTool } from "#tools/definition.js";

const tool = (description: string) =>
  defineTool({ description, execute: async () => ({}), inputSchema: { type: "object" } });

describe("codeAgentOf", () => {
  it("takes only what defineAgent returns, and builds each agent once", () => {
    const defined = defineAgent({ model: "openai/gpt-5.4", name: "once" });
    expect(codeAgentOf(defined)).toBe(codeAgentOf(defined));
    expect(() => codeAgentOf({ model: "openai/gpt-5.4" } as never)).toThrow(
      "Pass the agent defineAgent({ ... }) returns, not a plain object.",
    );
  });

  it("names the agent `agent` unless it says, and keeps its description", () => {
    const agent = codeAgentOf(defineAgent({ description: "Helps.", model: "openai/gpt-5.4" }));
    expect(agent.id).toBe("agent");
    expect(agent.description).toBe("Helps.");
  });

  it("reads its settings from the fields agent.ts uses", async () => {
    const agent = codeAgentOf(
      defineAgent({
        compaction: { model: "anthropic/claude-haiku-4.5", threshold: 0.6 },
        experimental: { workflow: { modelCallsPerStep: 4, retention: "default" } },
        limits: { sessionTimeoutMs: 60_000, sessionUsage: false },
        model: "openai/gpt-5.4",
        reasoning: "low",
      }),
    );
    expect(agent.settings).toMatchObject({
      compaction: { model: { id: "anthropic/claude-haiku-4.5" }, thresholdPercent: 0.6 },
      limits: { sessionTimeoutMs: 60_000 },
      modelCallsPerStep: 4,
      reasoning: "low",
      retention: "default",
    });
    // `false` turns the limit off, as it does for a compiled agent.
    expect(await agent.settings.limits?.sessionUsage?.({} as never)).toBe(false);
  });

  it.each([
    [{ build: { externalDependencies: ["sharp"] } }, '"build" doesn\'t apply'],
    [{ defaultTools: false }, '"defaultTools" doesn\'t apply'],
    [{ tool: false }, '"tool" doesn\'t apply'],
    [{ experimental: { workflow: { world: "local" } } }, '"experimental.workflow.world"'],
    [{ approval: () => undefined }, 'an agent-wide "approval" isn\'t supported there yet'],
  ])("refuses a field that doesn't apply in code (%o)", (fields, message) => {
    const defined = defineAgent({ model: "openai/gpt-5.4", name: "refused", ...fields } as never);
    expect(() => codeAgentOf(defined)).toThrow(message);
  });

  it("takes a compaction model by id only", () => {
    const instance = {
      doGenerate: async () => ({}),
      doStream: async () => ({}),
      modelId: "m",
      provider: "p",
      specificationVersion: "v4",
    } as const;
    const defined = defineAgent({ compaction: { model: instance }, model: "openai/gpt-5.4" });
    expect(() => codeAgentOf(defined)).toThrow("its compaction.model is a model id");
  });

  it("puts its own tool where the default of that name stood, as tools/bash.ts does", async () => {
    const mine = tool("My own bash.");
    const agent = codeAgentOf(
      defineAgent({
        definitions: eve.defaults({ without: ["agent", "web_fetch", "web_search"] }),
        model: "openai/gpt-5.4",
        tools: { bash: mine, lookup: tool("Looks things up.") },
      }),
    );
    const ids = (await agent.definitions()).map(({ id }) => id);
    expect(ids.filter((id) => id.startsWith("tool::"))).toEqual([
      "tool::bash",
      "tool::read_file",
      "tool::write_file",
      "tool::edit_file",
      "tool::lookup",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares a subagent under its key, with the id and node a file subagent has", () => {
    const parent = codeAgentOf(
      defineAgent({
        model: "openai/gpt-5.4",
        subagents: {
          reviewer: defineAgent({ description: "Reviews.", model: "openai/gpt-5.4" }),
        },
      }),
    );
    const reviewer = parent.subagents.get("reviewer");
    expect(reviewer?.description).toBe("Reviews.");
    expect(reviewer?.agent.id).toBe("agent/reviewer");
    expect(reviewer?.agent.nodeId).toBe("subagents/reviewer");
  });

  it("refuses a subagent without a description when it's built", () => {
    const defined = defineAgent({
      model: "openai/gpt-5.4",
      subagents: { reviewer: defineAgent({ model: "openai/gpt-5.4" }) },
    });
    expect(() => codeAgentOf(defined)).toThrow('Subagent "reviewer" needs a description');
  });

  it("leaves out eve's runtime definitions when bare", async () => {
    const own = defineContext("now", () => "noon");
    const ids = async (bare: boolean) =>
      (
        await codeAgentOf(
          defineAgent({ bare, definitions: [own], model: "openai/gpt-5.4" }),
        ).definitions()
      ).map(({ id }) => id);
    expect(await ids(true)).toEqual([expect.any(String), "context:now"]);
    expect((await ids(false)).length).toBeGreaterThan(2);
  });
});
