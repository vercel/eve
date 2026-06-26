import { describe, expect, it } from "vitest";

import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { McpSessionSlot } from "#runtime/connections/mcp-session-store.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";

function makeConnection(
  nameOrOpts: string | (Partial<ResolvedConnectionDefinition> & { connectionName: string }),
): ResolvedConnectionDefinition {
  const name = typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts.connectionName;
  const overrides = typeof nameOrOpts === "string" ? {} : nameOrOpts;
  return {
    authorization: {
      getToken: async () => ({ token: `token-${name}` }),
      principalType: "app",
    },
    connectionName: name,
    description: `${name} connection`,
    logicalPath: `agent/connections/${name}.ts`,
    protocol: "mcp",
    sourceId: `connections/${name}`,
    sourceKind: "module",
    url: `https://${name}.example.com/mcp`,
    ...overrides,
  };
}

describe("ConnectionRegistryImpl", () => {
  it("returns connection names", () => {
    const registry = new ConnectionRegistryImpl([
      makeConnection("linear"),
      makeConnection("github"),
    ]);

    expect(registry.getConnectionNames()).toEqual(["linear", "github"]);
  });

  it("returns all resolved definitions", () => {
    const connections = [makeConnection("linear"), makeConnection("github")];
    const registry = new ConnectionRegistryImpl(connections);

    expect(registry.getConnections()).toBe(connections);
  });

  it("returns an empty list when there are no connections", () => {
    const registry = new ConnectionRegistryImpl([]);

    expect(registry.getConnectionNames()).toEqual([]);
    expect(registry.getConnections()).toEqual([]);
  });

  it("creates a client lazily on getClient", () => {
    const registry = new ConnectionRegistryImpl([makeConnection("linear")]);

    const client = registry.getClient("linear");
    expect(client).toBeDefined();
  });

  it("returns the same client instance on repeated getClient calls", () => {
    const registry = new ConnectionRegistryImpl([makeConnection("linear")]);

    const first = registry.getClient("linear");
    const second = registry.getClient("linear");
    expect(first).toBe(second);
  });

  it("returns different clients for different connections", () => {
    const registry = new ConnectionRegistryImpl([
      makeConnection("linear"),
      makeConnection("github"),
    ]);

    const linearClient = registry.getClient("linear");
    const githubClient = registry.getClient("github");
    expect(linearClient).not.toBe(githubClient);
  });

  it("throws for an unregistered connection name", () => {
    const registry = new ConnectionRegistryImpl([makeConnection("linear")]);

    expect(() => registry.getClient("nonexistent")).toThrow(
      'Connection "nonexistent" is not registered.',
    );
  });

  it("dispose clears the client cache", async () => {
    const registry = new ConnectionRegistryImpl([makeConnection("linear")]);

    const before = registry.getClient("linear");
    await registry.dispose();
    const after = registry.getClient("linear");

    expect(before).not.toBe(after);
  });

  it("hands the matching session slot to a stateful mcp client and reports updates", async () => {
    const slots = new Map([
      ["a", { stateKey: "eve.mcp.session.a.anonymous", initialId: undefined } as McpSessionSlot],
    ]);
    const registry = new ConnectionRegistryImpl(
      [makeConnection({ connectionName: "a", session: "stateful" })],
      slots,
    );

    // The client mutates its slot when it negotiates a session.
    slots.get("a")!.sessionId = "negotiated";

    expect(registry.collectMcpSessionUpdates()).toEqual([
      { stateKey: "eve.mcp.session.a.anonymous", sessionId: "negotiated" },
    ]);
  });
});
