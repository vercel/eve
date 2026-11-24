import { expect, it, vi } from "vitest";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { listToolMetadata } from "#execution/catalog/connection-auth.js";
import { OpenApiConnectionClient } from "#runtime/connections/openapi-client.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionClient, ConnectionToolMetadata } from "#shared/connection-types.js";

const remote: ConnectionToolMetadata = { name: "search", description: "Search", inputSchema: {} };
const issues = { connectionName: "issues" };

function client(): ConnectionClient {
  return {
    close: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    executeTool: vi.fn(async () => {}),
    getToolMetadata: vi.fn(async () => [remote]),
    eventActions: { list: vi.fn(async () => []), execute: vi.fn(async () => {}) },
  };
}

it("lists ordinary MCP tools without fetching the connection's events", async () => {
  const connection = client();
  expect(await listToolMetadata(issues, connection)).toEqual([remote]);
  expect(connection.eventActions!.list).not.toHaveBeenCalled();
});

it("preserves sign-in when tool discovery requires authorization", async () => {
  const connection = client();
  const error = new ConnectionAuthorizationRequiredError("issues");
  vi.mocked(connection.getToolMetadata).mockRejectedValue(error);
  await expect(listToolMetadata(issues, connection)).rejects.toBe(error);
});

it("applies the connection's tool filter to ordinary tools", async () => {
  expect(await listToolMetadata({ ...issues, tools: { block: ["search"] } }, client())).toEqual([]);
});

it.each([
  { operations: { block: ["repos.delete"] }, listed: ["repos_list"] },
  { operations: { allow: ["repos.list"] }, listed: ["repos_list"] },
  { operations: { block: ["repos_delete"] }, listed: ["repos_list"] },
])(
  "matches OpenAPI operation filters against the operationId: %j",
  async ({ operations, listed }) => {
    const operation = (operationId: string) => ({
      operationId,
      responses: { "200": { description: "ok" } },
    });
    const connection = {
      connectionName: "github",
      description: "GitHub",
      logicalPath: "connections/github.ts",
      protocol: "openapi",
      sourceId: "connections/github",
      sourceKind: "module",
      spec: {
        openapi: "3.0.3",
        info: { title: "GitHub", version: "1.0.0" },
        paths: {
          "/repos": { delete: operation("repos.delete"), get: operation("repos.list") },
        },
      },
      tools: operations,
      url: "https://api.example.com",
    } satisfies ResolvedConnectionDefinition;

    const tools = await listToolMetadata(connection, new OpenApiConnectionClient(connection));
    expect(tools.map((tool) => tool.name)).toEqual(listed);
  },
);
