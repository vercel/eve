// @linux-only: definition ordering; compiled from memory
import { describe, expect, it } from "vitest";

import { defineDynamic } from "#dynamic/definition.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineMemory } from "#public/memory/index.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { defineTool } from "#tools/definition.js";

// The order of a session's definitions is its contract: the first to offer a tool name keeps it,
// and eve's catalog has to come after every tool. A compiled agent's order comes from two places,
// which file kind lands in which field (`agentContentsOf`) and where each field sits
// (`agentDefinitionsOf`), so this compiles one file of each kind and reads the order back.
describe("a compiled agent's definitions", () => {
  it("come in the order their contract sets, whatever kind of file each is", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "definition-order" },
      modules: [
        {
          logicalPath: "hooks/audit.ts",
          loadNamespace: async () => ({ default: defineHook({ events: {} }) }),
        },
        {
          logicalPath: "instructions/policy.ts",
          loadNamespace: async () => ({
            default: defineDynamic(() => defineInstructions({ content: "Ship carefully." })),
          }),
        },
        {
          logicalPath: "connections/docs.ts",
          loadNamespace: async () => ({
            default: defineMcpClientConnection({
              description: "Team docs.",
              url: "https://example.com/mcp",
            }),
          }),
        },
        {
          logicalPath: "memory/notes.ts",
          loadNamespace: async () => ({
            default: defineMemory({
              provider: { recall: { "turn.started": () => ({ messages: [] }) } },
              scope: "test",
            }),
          }),
        },
        {
          logicalPath: "tools/lookup.ts",
          loadNamespace: async () => ({
            default: defineDynamic(() => ({
              lookup: defineTool({
                description: "Look something up.",
                execute: async () => ({ found: true }),
                inputSchema: {},
              }),
            })),
          }),
        },
      ],
    });

    const ids = await runtime.run(async () => {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const definitions = await fromCompiledBundle(bundle).definitions();
      return definitions.map(({ id }) => id);
    });

    expect(ids).toMatchInlineSnapshot(`
      [
        "hook:audit",
        "eve.model",
        "eve.instructions",
        "instructions:policy",
        "eve.workspace",
        "eve.connections",
        "eve.tools",
        "memory:notes:recall",
        "tool::notes",
        "tool::lookup",
        "eve.skills",
        "eve.approvals",
        "eve.builtins",
        "eve.catalog",
        "eve.model.parent",
      ]
    `);
  });
});
