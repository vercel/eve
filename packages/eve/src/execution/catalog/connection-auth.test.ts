import { expect, it, vi } from "vitest";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { listToolMetadata } from "#execution/catalog/connection-auth.js";
import type { ConnectionClient, ConnectionToolMetadata } from "#shared/connection-types.js";

const remote: ConnectionToolMetadata = { name: "search", description: "Search", inputSchema: {} };
const management: ConnectionToolMetadata = {
  name: "events_unsubscribe",
  description: "Stop",
  inputSchema: {},
};

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
  expect(await listToolMetadata("issues", connection)).toEqual([remote, management]);
});

it("keeps management actions available when MCP tool discovery fails", async () => {
  const connection = client();
  vi.mocked(connection.getToolMetadata).mockRejectedValue(new Error("MCP unavailable"));
  expect(await listToolMetadata("issues", connection)).toEqual([management]);
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
  await expect(listToolMetadata("issues", connection)).rejects.toBe(error);
});

it("does not let hung event discovery hide responsive MCP tools", async () => {
  vi.useFakeTimers();
  try {
    const connection = client();
    vi.mocked(connection.eventActions!.metadata).mockReturnValue(new Promise(() => {}));
    const listing = listToolMetadata("issues", connection);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await listing).toEqual([remote, management]);
  } finally {
    vi.useRealTimers();
  }
});

it("rejects ambiguous catalog names without routing a remote tool to an event action", async () => {
  const connection = client();
  vi.mocked(connection.getToolMetadata).mockResolvedValue([management]);
  await expect(listToolMetadata("issues", connection)).rejects.toThrow("event action namespace");
  expect(connection.eventActions!.execute).toHaveBeenCalledTimes(0);
});
