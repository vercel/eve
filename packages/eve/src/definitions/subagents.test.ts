import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { DynamicContext } from "#dynamic/definition.js";
import { mockModel } from "#evals/mock-model.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { chatgpt } from "#public/models/openai/index.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";

import {
  beforeModelCall,
  dynamicTools,
  evaluationError,
  definitionSession,
} from "#internal/testing/definition-session.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineRemoteAgent } from "#public/definitions/remote-agent.js";
import { readDynamicSubagentSelections } from "./subagents.js";

const analyst = (description = "Analyzes the books.") =>
  defineAgent({ description, model: "openai/gpt-5.4" });

describe("dynamic subagents", () => {
  it("offers a returned agent as a tool, and omits one whose function returns null", async () => {
    const { ctx } = definitionSession({
      subagents: [
        { evaluate: () => analyst(), name: "analyst" },
        { evaluate: () => null, name: "auditor" },
      ],
    });
    await beforeModelCall(ctx);

    expect((await dynamicTools(ctx)).map(({ name }) => name)).toEqual(["analyst"]);
    expect(Object.keys(readDynamicSubagentSelections(ctx))).toEqual(["subagents/analyst"]);
  });

  it("keeps a tool: false agent selectable without offering it to the model", async () => {
    const { ctx } = definitionSession({
      subagents: [{ evaluate: () => analyst(), name: "analyst", tool: false }],
    });
    await beforeModelCall(ctx);

    expect(await dynamicTools(ctx)).toEqual([]);
    expect(readDynamicSubagentSelections(ctx)["subagents/analyst"]?.kind).toBe("subagent");
  });

  it("selects a remote agent with the URL it returns", async () => {
    const { ctx } = definitionSession({
      subagents: [
        {
          evaluate: () =>
            defineRemoteAgent({ description: "Finance.", url: "https://finance.example" }),
          name: "finance",
        },
      ],
    });
    await beforeModelCall(ctx);

    expect(readDynamicSubagentSelections(ctx)["subagents/finance"]).toMatchObject({
      kind: "remote",
      remoteAgent: { url: "https://finance.example" },
    });
  });

  it("reads the model the session chose", async () => {
    const seen: string[] = [];
    const { ctx } = definitionSession({
      model: { id: "openai/gpt-5.4" },
      subagents: [
        {
          evaluate: (ctx) => {
            seen.push(ctx.model.id);
            return null;
          },
          name: "analyst",
        },
      ],
    });
    await beforeModelCall(ctx);

    expect(seen).toEqual(["openai/gpt-5.4"]);
  });

  it.each([
    ["an authored tool's name", { toolNames: ["analyst"] }, 'collides with the tool "analyst"'],
    ["eve's namespace", { name: "eve" }, 'uses the reserved name "eve"'],
  ])("rejects %s", async (_name, input, message) => {
    const { name = "analyst", ...session } = input as { name?: string; toolNames?: string[] };
    const { ctx } = definitionSession({
      ...session,
      subagents: [{ evaluate: () => analyst(), name }],
    });
    expect(await evaluationError(ctx)).toContain(message);
  });

  it("points packaging configuration at the root agent", async () => {
    const { ctx } = definitionSession({
      subagents: [
        {
          evaluate: () =>
            defineAgent({
              build: { externalDependencies: ["duckdb"] },
              description: "Analyzes the books.",
              model: "openai/gpt-5.4",
            }),
          name: "analyst",
        },
      ],
    });
    expect(await evaluationError(ctx)).toContain(
      "Declare packaging configuration such as build.externalDependencies on the root agent",
    );
  });
});

describe("a dynamic subagent that runs its parent's model", () => {
  const agentSource = {
    exportName: undefined,
    logicalPath: "agent.ts",
    sourceId: "agent.ts",
    sourceKind: "module" as const,
  };
  const followsParent = (ctx: DynamicContext) =>
    defineAgent({ description: "Edits the agent.", model: ctx.model.id });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { label: "chatgpt()", contextWindowTokens: 200_000, model: () => chatgpt() },
    { label: "mockModel", contextWindowTokens: 1_000_000, model: () => mockModel() },
  ])(
    "keeps a $label parent's provider across a restore",
    async ({ contextWindowTokens, model }) => {
      const instance = model();
      const parent: RuntimeModelReference = {
        contextWindowTokens,
        id: formatLanguageModelGatewayId(instance),
        source: agentSource,
      };
      const { ctx } = definitionSession({
        model: parent,
        subagents: [{ evaluate: followsParent, name: "editor" }],
      });
      await beforeModelCall(ctx);

      const selection = readDynamicSubagentSelections(ctx)["subagents/editor"];
      if (selection?.kind !== "subagent") throw new Error("Expected a local subagent.");
      const restored = JSON.parse(
        JSON.stringify(selection.agentConfig.model),
      ) as RuntimeModelReference;
      expect(restored).toEqual({ ...parent, sourceNodeId: "root" });

      vi.stubEnv("NODE_ENV", "production");
      const moduleMap: CompiledModuleMap = {
        nodes: {
          root: { modules: { "agent.ts": { default: defineAgent({ model: instance }) } } },
          "subagents/editor": { modules: {} },
        },
      };
      await expect(
        resolveRuntimeModelReference(restored, { moduleMap, nodeId: "subagents/editor" }),
      ).resolves.toBe(instance);
    },
  );

  it("inherits a Gateway parent's id and window", async () => {
    const { ctx } = definitionSession({
      model: { contextWindowTokens: 1_000_000, id: "acme/custom-model" },
      subagents: [{ evaluate: followsParent, name: "editor" }],
    });
    await beforeModelCall(ctx);

    expect(readDynamicSubagentSelections(ctx)["subagents/editor"]).toMatchObject({
      agentConfig: { model: { contextWindowTokens: 1_000_000, id: "acme/custom-model" } },
    });
  });

  it("inherits nothing for a model the subagent names itself", async () => {
    const { ctx } = definitionSession({
      model: { contextWindowTokens: 200_000, id: "codex/gpt-5.5", source: agentSource },
      subagents: [{ evaluate: () => analyst(), name: "analyst" }],
    });
    await beforeModelCall(ctx);

    const selection = readDynamicSubagentSelections(ctx)["subagents/analyst"];
    if (selection?.kind !== "subagent") throw new Error("Expected a local subagent.");
    expect(selection.agentConfig.model).toEqual({
      contextWindowTokens: 400_000,
      id: "openai/gpt-5.4",
    });
  });

  it("still rejects a provider instance the subagent returns", async () => {
    const { ctx } = definitionSession({
      subagents: [
        {
          evaluate: () => defineAgent({ description: "Edits the agent.", model: chatgpt() }),
          name: "editor",
        },
      ],
    });
    expect(await evaluationError(ctx)).toContain("durable model selections must be serializable");
  });
});
