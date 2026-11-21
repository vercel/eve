import { afterEach, describe, expect, it, vi } from "vitest";

import { McpClientPool } from "#runtime/connections/mcp-client-pool.js";
import type { McpConnectionClient } from "#runtime/connections/mcp-client.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

function connection(name: string): ResolvedConnectionDefinition {
  return {
    connectionName: name,
    description: name,
    logicalPath: `agent/connections/${name}.ts`,
    protocol: "mcp",
    sourceId: `connections/${name}`,
    sourceKind: "module",
    url: `https://${name}.example.com/mcp`,
  };
}

function spyClose(client: McpConnectionClient) {
  return vi.spyOn(client, "close").mockResolvedValue(undefined);
}

describe("McpClientPool", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hands the same client to later borrowers in the same scope", async () => {
    const pool = new McpClientPool();
    const linear = connection("linear");

    const first = pool.acquire("turn-1", linear);
    const close = spyClose(first);
    await pool.release(first);
    const second = pool.acquire("turn-1", linear);

    expect(second).toBe(first);
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps scopes and connection definitions apart", () => {
    const pool = new McpClientPool();
    const linear = connection("linear");

    const client = pool.acquire("turn-1", linear);

    expect(pool.acquire("turn-2", linear)).not.toBe(client);
    expect(pool.acquire("turn-1", connection("linear"))).not.toBe(client);
  });

  it("closes a returned client after it sits idle", async () => {
    vi.useFakeTimers();
    const pool = new McpClientPool({ idleMs: 1_000 });
    const client = pool.acquire("turn-1", connection("linear"));
    const close = spyClose(client);

    await pool.release(client);
    await vi.advanceTimersByTimeAsync(999);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it("does not close a client while another step still borrows it", async () => {
    vi.useFakeTimers();
    const pool = new McpClientPool({ idleMs: 1_000 });
    const linear = connection("linear");
    const client = pool.acquire("turn-1", linear);
    pool.acquire("turn-1", linear);
    const close = spyClose(client);

    await pool.release(client, { discard: true });
    expect(close).not.toHaveBeenCalled();
    expect(pool.acquire("turn-1", linear)).not.toBe(client);

    await pool.release(client);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a failed client as soon as it is returned", async () => {
    const pool = new McpClientPool();
    const linear = connection("linear");
    const client = pool.acquire("turn-1", linear);
    const close = spyClose(client);
    vi.spyOn(client, "reusable", "get").mockReturnValue(false);

    await pool.release(client);

    expect(close).toHaveBeenCalledOnce();
    expect(pool.acquire("turn-1", linear)).not.toBe(client);
  });

  it("closes the least recently returned idle clients over the cap", async () => {
    const pool = new McpClientPool({ maxIdleClients: 1 });
    const older = pool.acquire("turn-1", connection("linear"));
    const newer = pool.acquire("turn-2", connection("linear"));
    const closeOlder = spyClose(older);
    const closeNewer = spyClose(newer);

    await pool.release(older);
    await pool.release(newer);

    expect(closeOlder).toHaveBeenCalledOnce();
    expect(closeNewer).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
  });
});
