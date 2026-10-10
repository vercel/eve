import { expect, it, vi } from "vitest";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { defineTool } from "#tools/definition.js";
import { defineDynamic } from "#dynamic/definition.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { validateToolStubTargets } from "#tool-stubs/validate-targets.js";

it.each([false, true])(
  "checks paths without resolving dynamic tools (dynamic: %s)",
  async (dynamic) => {
    const resolve = vi.fn(() => ({}));
    const lookup = defineTool({
      description: "List tasks.",
      inputSchema: { type: "object" },
      execute: () => [],
    });
    const runtime = await createTestRuntime({
      modules: [
        { logicalPath: "tools/list_tasks.ts", loadNamespace: async () => ({ default: lookup }) },
        {
          logicalPath: "connections/tasks.ts",
          loadNamespace: async () => ({
            default: defineMcpClientConnection({
              url: "https://tasks.invalid/mcp",
              description: "Tasks.",
            }),
          }),
        },
        ...(dynamic
          ? [
              {
                logicalPath: "tools/dynamic.ts",
                loadNamespace: async () => ({
                  default: defineDynamic({ events: { "session.started": resolve } }),
                }),
              },
            ]
          : []),
      ],
    });
    await runtime.run(async () => {
      const { graph } = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: { kind: "bundled" },
      });
      const check = (tool: string) =>
        validateToolStubTargets([{ id: "rule", tool, outcome: { response: [] } }], graph);
      for (const tool of ["list_tasks", "agent/list_tasks", "tasks__list"]) {
        expect(() => check(tool), tool).not.toThrow();
      }
      for (const tool of ["lsit_tasks", "absent__list"]) {
        if (dynamic) expect(() => check(tool), tool).not.toThrow();
        else expect(() => check(tool), tool).toThrow(/unknown or unsupported tool path/);
      }
      for (const tool of ["unknown/list_tasks", "list_tasks/nested", "agent//list_tasks"]) {
        expect(() => check(tool), tool).toThrow(/unknown or unsupported tool path/);
      }
      expect(resolve).not.toHaveBeenCalled();
    });
  },
);
