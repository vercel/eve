import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { SessionKey, type Session } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import type { HarnessSessionBase } from "#harness/types.js";
import {
  createStatefulMcpServer,
  type StatefulMcpServer,
} from "#internal/testing/stateful-mcp-server.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { mcpClientPool } from "#runtime/connections/mcp-client-pool.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

const testSession = vi.hoisted(() => ({ current: undefined as Session | undefined }));

vi.mock("#context/providers/session.js", async () => {
  const { SessionKey: key } = await import("#context/keys.js");
  return {
    sessionProvider: {
      create: () =>
        testSession.current === undefined ? undefined : { value: testSession.current },
      key,
    },
  };
});
vi.mock("#context/providers/sandbox.js", () => ({
  sandboxProvider: { create: () => undefined, key: { name: "test.sandbox" } },
}));
vi.mock("#runtime/connections/mcp-client-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#runtime/connections/mcp-client-pool.js")>();
  return { ...actual, mcpClientPool: new actual.McpClientPool({ idleMs: 20 }) };
});

const connection: ResolvedConnectionDefinition = {
  connectionName: "fixture",
  description: "stateful MCP fixture",
  logicalPath: "agent/connections/fixture.ts",
  protocol: "mcp",
  sourceId: "connections/fixture",
  sourceKind: "module",
  url: "http://127.0.0.1:8000/mcp",
};

const agent = fromCompiledBundle({
  graph: { root: { agent: { connections: [connection], definitions: [] } } },
} as never);

function session(turn: number, principalId = "user-1"): Session {
  const auth = {
    attributes: {},
    authenticator: "test",
    principalId,
    principalType: "user",
  };
  return {
    auth: { current: auth, initiator: auth },
    sessionId: "session-1",
    turn: { id: `turn_${turn}`, sequence: turn },
  };
}

async function step(current: Session): Promise<void> {
  testSession.current = current;
  const ctx = new ContextContainer();
  ctx.set(SessionAgentKey, agent);
  await withContextScope(ctx, {} as HarnessSessionBase, async (harnessSession) => {
    expect(ctx.get(SessionKey)).toBe(current);
    const client = ctx.require(ConnectionRegistryKey).getClient("fixture");
    await client.getToolMetadata();
    await client.executeTool("ping", {}, { callId: "call-1" });
    return { result: undefined, session: harnessSession };
  });
}

describe("MCP clients shared across the steps of a turn", () => {
  let server: StatefulMcpServer;

  const sessions = () =>
    new Set(server.requests.map((request) => request.sessionId).filter((id) => id !== null));
  const initializes = () =>
    server.requests.filter(
      (request) =>
        request.method === "POST" && request.sessionId === null && request.status === 200,
    );

  beforeEach(() => {
    server = createStatefulMcpServer();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(async () => {
    testSession.current = undefined;
    await mcpClientPool.closeIdle();
    vi.unstubAllGlobals();
  });

  it("reuses one MCP session and tool listing for every step of a turn", async () => {
    await step(session(1));
    const afterFirstStep = server.requests.length;
    await step(session(1));
    await step(session(1));

    expect(initializes()).toHaveLength(1);
    expect(sessions().size).toBe(1);
    expect(server.requests.length - afterFirstStep).toBe(2);

    await server.waitForRequest((request) => request.method === "DELETE");
    expect(server.liveSessions.size).toBe(0);
    expect(mcpClientPool.size).toBe(0);
  });

  it("reconnects when the server forgot the session between steps", async () => {
    await step(session(1));
    const [expired] = sessions();
    await server.fetch(connection.url, {
      headers: { "mcp-session-id": expired! },
      method: "DELETE",
    });
    expect(server.liveSessions.size).toBe(0);

    await step(session(1));

    expect(initializes()).toHaveLength(2);
  });

  it("starts a new MCP session for a new turn or a different caller", async () => {
    await step(session(1));
    await step(session(2));
    await step(session(2, "user-2"));

    expect(initializes()).toHaveLength(3);
    expect(sessions().size).toBe(3);
  });

  it("keeps a separate client per step when there is no session", async () => {
    await step(undefined as never);
    await step(undefined as never);

    expect(initializes()).toHaveLength(2);
    expect(server.requests.filter((request) => request.method === "DELETE")).toHaveLength(2);
  });
});
