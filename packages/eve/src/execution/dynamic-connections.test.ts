import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import type { ResolvedDynamicConnectionResolver } from "#runtime/types.js";

describe("bindDynamicConnections", () => {
  it("rehydrates the active session and turn before a resumed step", async () => {
    const seen: string[] = [];
    const { lifecycle, registry } = createLifecycle({
      eventNames: ["session.started", "turn.started"],
      events: {
        "session.started": (event) => {
          seen.push((event as { type: string }).type);
          return { session: connection("Session account") };
        },
        "turn.started": (event) => {
          seen.push((event as { type: string }).type);
          return { turn: connection("Turn account") };
        },
      },
    });

    await lifecycle.rehydrate(
      { sequence: 3, sessionStarted: true, stepIndex: 1, turnId: "turn_3" },
      { agentId: "agent", eveVersion: "test" },
      [],
      false,
    );

    expect(seen).toEqual(["session.started", "turn.started"]);
    expect(registry.getConnectionNames()).toEqual(["turn"]);
  });

  it("rehydrates only the session while between turns", async () => {
    const seen: string[] = [];
    const { lifecycle, registry } = createLifecycle({
      eventNames: ["session.started", "turn.started"],
      events: {
        "session.started": (event) => {
          seen.push((event as { type: string }).type);
          return { session: connection("Session account") };
        },
        "turn.started": (event) => {
          seen.push((event as { type: string }).type);
          return { turn: connection("Turn account") };
        },
      },
    });

    await lifecycle.rehydrate(
      { sequence: 4, sessionStarted: true, stepIndex: 0, turnId: "" },
      { agentId: "agent", eveVersion: "test" },
      [],
      true,
    );

    expect(seen).toEqual(["session.started"]);
    expect(registry.getConnectionNames()).toEqual(["session"]);
  });
});

function createLifecycle(
  resolver: Pick<ResolvedDynamicConnectionResolver, "eventNames" | "events">,
) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "session-1");
  const registry = new ConnectionRegistryImpl([]);
  ctx.set(ConnectionRegistryKey, registry);
  const lifecycle = bindDynamicConnections(ctx, {
    dynamicConnectionResolvers: [
      {
        ...resolver,
        logicalPath: "connections/accounts.ts",
        slug: "accounts",
        sourceId: "connections/accounts",
        sourceKind: "module",
      },
    ],
  });
  return { lifecycle, registry };
}

function connection(description: string) {
  return defineMcpClientConnection({
    description,
    url: "https://mcp.example.com",
  });
}
