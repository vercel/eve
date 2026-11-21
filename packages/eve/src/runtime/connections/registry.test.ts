import { describe, expect, it, vi } from "vitest";

import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { McpClientPool } from "#runtime/connections/mcp-client-pool.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";

function makeConnection(name: string): ResolvedConnectionDefinition {
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

  it("borrows MCP clients from a shared pool and returns them on dispose", async () => {
    const pool = new McpClientPool();
    const connections = [makeConnection("linear")];
    const first = new ConnectionRegistryImpl(connections, { pool, scope: "turn-1" });
    const client = first.getClient("linear");
    const close = vi.spyOn(client, "close");

    await first.dispose();
    const second = new ConnectionRegistryImpl(connections, { pool, scope: "turn-1" });

    expect(second.getClient("linear")).toBe(client);
    expect(close).not.toHaveBeenCalled();
  });

  it("closes a borrowed client when a dynamic definition replaces it", async () => {
    const pool = new McpClientPool();
    const registry = new ConnectionRegistryImpl([makeConnection("linear")], {
      pool,
      scope: "turn-1",
    });
    const client = registry.getClient("linear");
    const close = vi.spyOn(client, "close");

    await registry.replaceDynamicConnections(new Map([["resolver", [makeConnection("linear")]]]));

    expect(close).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it("keeps dynamic connections out of the shared pool", async () => {
    const pool = new McpClientPool();
    const registry = new ConnectionRegistryImpl([], { pool, scope: "turn-1" });
    await registry.replaceDynamicConnections(new Map([["resolver", [makeConnection("linear")]]]));
    const close = vi.spyOn(registry.getClient("linear"), "close");

    await registry.dispose();

    expect(close).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it("does not borrow from the pool after dispose", async () => {
    const pool = new McpClientPool();
    const registry = new ConnectionRegistryImpl([makeConnection("linear")], {
      pool,
      scope: "turn-1",
    });
    await registry.dispose();

    registry.getClient("linear");

    expect(pool.size).toBe(0);
  });
});
