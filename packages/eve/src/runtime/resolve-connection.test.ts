import { describe, expect, it, vi } from "vitest";

import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledConnectionDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { ConnectionToolCallDefinition } from "#public/definitions/connections/tool-call.js";
import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import { toolResultFrom } from "#public/tools/result.js";
import { resolveConnectionDefinition } from "#runtime/resolve-connection.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { ConnectionAuthResolver, HeadersDefinition } from "#shared/connection-types.js";

describe("resolveConnectionDefinition", () => {
  it("preserves live MCP callbacks for request-time resolution", async () => {
    const auth: ConnectionAuthResolver = (ctx) => ({
      getToken: async () => ({ token: ctx.session.id }),
    });
    const headers: HeadersDefinition = (ctx) => ({ "X-Session": ctx.session.id });
    const toolCall: ConnectionToolCallDefinition = {
      providedArguments: { meta: ({ session }) => ({ sessionId: session.id }) },
    };
    const definition: CompiledConnectionDefinition = {
      connectionName: "warehouse",
      description: "Tenant warehouse",
      logicalPath: "connections/warehouse.ts",
      protocol: "mcp",
      sourceId: "connections/warehouse",
      sourceKind: "module",
      url: "https://warehouse.example.com/mcp",
    };
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            [definition.sourceId]: {
              default: {
                auth,
                description: definition.description,
                headers,
                toolCall,
                url: definition.url,
              },
            },
          },
        },
      },
    };

    const resolved = await resolveConnectionDefinition(definition, moduleMap, undefined);

    expect(resolved.authorization).toBe(auth);
    expect(resolved.headers).toBe(headers);
    expect(resolved.toolCall).toBe(toolCall);
  });
});

describe("toolResultFrom identity for connections sharing a host (#202)", () => {
  it("narrows each same-host OpenAPI connection through a copy of its definition", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const baseUrl = "https://example.atlassian.net";
    const defineJira = () =>
      defineOpenAPIConnection({ baseUrl, description: "Jira", spec: { openapi: "3.0.0" } });
    const defineConfluence = () =>
      defineOpenAPIConnection({ baseUrl, description: "Confluence", spec: { openapi: "3.0.0" } });

    for (const [connectionName, loaded] of [
      ["jira", defineJira()],
      ["confluence", defineConfluence()],
    ] as const) {
      const sourceId = `connections/${connectionName}`;
      await resolveConnectionDefinition(
        {
          connectionName,
          description: loaded.description,
          logicalPath: `${sourceId}.ts`,
          protocol: "openapi",
          sourceId,
          sourceKind: "module",
          url: baseUrl,
        },
        {
          nodes: {
            [ROOT_COMPILED_AGENT_NODE_ID]: { modules: { [sourceId]: { default: loaded } } },
          },
        },
        undefined,
      );
    }

    // A hook bundled separately imports its own instance of each connection module.
    const jira = defineJira();
    const confluence = defineConfluence();
    const result = (toolName: string): RuntimeActionResult => ({
      callId: "call_1",
      kind: "tool-result",
      output: {},
      toolName,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(toolResultFrom(result("jira__getIssue"), jira)?.connectionToolName).toBe("getIssue");
    expect(toolResultFrom(result("confluence__getPage"), confluence)?.connectionToolName).toBe(
      "getPage",
    );
    expect(toolResultFrom(result("confluence__getPage"), jira)).toBeUndefined();
  });

  it("narrows an OpenAPI connection without baseUrl through a copy of its definition", async () => {
    const define = () =>
      defineOpenAPIConnection({
        description: "Spec-only API",
        spec: "https://spec-only.example.com/openapi.json",
      });
    const sourceId = "connections/spec-only";
    await resolveConnectionDefinition(
      {
        connectionName: "spec_only",
        description: "Spec-only API",
        logicalPath: `${sourceId}.ts`,
        protocol: "openapi",
        sourceId,
        sourceKind: "module",
        url: "",
      },
      {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: { modules: { [sourceId]: { default: define() } } },
        },
      },
      undefined,
    );

    const match = toolResultFrom(
      { callId: "call_1", kind: "tool-result", output: {}, toolName: "spec_only__list" },
      define(),
    );
    expect(match?.connectionToolName).toBe("list");
  });
});
