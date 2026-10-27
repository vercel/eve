import { expect, it, vi } from "vitest";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { listToolMetadata } from "#execution/catalog/connection-auth.js";
import { OpenApiConnectionClient } from "#runtime/connections/openapi-client.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionClient, ConnectionToolMetadata } from "#shared/connection-types.js";

const remote: ConnectionToolMetadata = { name: "search", description: "Search", inputSchema: {} };
const management: ConnectionToolMetadata = {
  name: "events_unsubscribe",
  description: "Stop",
  inputSchema: {},
};

const issues = { connectionName: "issues" };

function client(): ConnectionClient {
  return {
    close: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    executeTool: vi.fn(async () => {}),
    getToolMetadata: vi.fn(async () => [remote]),
    eventActions: {
      ownsName: (name) => name === management.name,
      metadata: vi.fn(async () => [management]),
      recoveryMetadata: () => [management],
      execute: vi.fn(async () => {}),
    },
  };
}

it("keeps ordinary MCP tools available when event discovery fails", async () => {
  const connection = client();
  vi.mocked(connection.eventActions!.metadata).mockRejectedValue(new Error("Events unavailable"));
  expect(await listToolMetadata(issues, connection)).toEqual([remote, management]);
});

it("keeps management actions available when MCP tool discovery fails", async () => {
  const connection = client();
  vi.mocked(connection.getToolMetadata).mockRejectedValue(new Error("MCP unavailable"));
  expect(await listToolMetadata(issues, connection)).toEqual([management]);
});

it.each([
  { remote: true, events: true },
  { remote: true, events: false },
  { remote: false, events: true },
])("preserves sign-in when discovery requires authorization: %j", async (required) => {
  const connection = client();
  const error = new ConnectionAuthorizationRequiredError("issues");
  if (required.remote) vi.mocked(connection.getToolMetadata).mockRejectedValue(error);
  if (required.events) vi.mocked(connection.eventActions!.metadata).mockRejectedValue(error);
  await expect(listToolMetadata(issues, connection)).rejects.toBe(error);
});

it("does not let hung event discovery hide responsive MCP tools", async () => {
  vi.useFakeTimers();
  try {
    const connection = client();
    vi.mocked(connection.eventActions!.metadata).mockReturnValue(new Promise(() => {}));
    const listing = listToolMetadata(issues, connection);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await listing).toEqual([remote, management]);
  } finally {
    vi.useRealTimers();
  }
});

it("offers event actions that take longer than half the listing deadline to discover", async () => {
  vi.useFakeTimers();
  try {
    const connection = client();
    const subscribe = { name: "events_subscribe_issue", description: "Watch", inputSchema: {} };
    vi.mocked(connection.eventActions!.metadata).mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve([subscribe, management]), 7_000)),
    );
    const listing = listToolMetadata(issues, connection);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await listing).toEqual([remote, subscribe, management]);
  } finally {
    vi.useRealTimers();
  }
});

it("rejects ambiguous catalog names without routing a remote tool to an event action", async () => {
  const connection = client();
  vi.mocked(connection.getToolMetadata).mockResolvedValue([management]);
  await expect(listToolMetadata(issues, connection)).rejects.toThrow("event action namespace");
  expect(connection.eventActions!.execute).toHaveBeenCalledTimes(0);
});

it.each([
  { tools: { block: ["events_unsubscribe"] }, listed: [remote] },
  { tools: { allow: ["search"] }, listed: [remote] },
  { tools: { allow: ["events_unsubscribe"] }, listed: [management] },
])("applies the connection's tool filter to event actions too: %j", async ({ tools, listed }) => {
  expect(await listToolMetadata({ ...issues, tools }, client())).toEqual(listed);
});

it("applies the connection's tool filter to ordinary tools when event discovery is off", async () => {
  const connection = { ...client(), eventActions: undefined };
  expect(await listToolMetadata({ ...issues, tools: { block: ["search"] } }, connection)).toEqual(
    [],
  );
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
