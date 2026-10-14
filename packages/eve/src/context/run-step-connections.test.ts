import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { withContextScope } from "#context/run-step.js";
import type { HarnessSessionBase } from "#harness/types.js";
import { McpConnectionClient } from "#runtime/connections/mcp-client.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

vi.mock("#context/providers/session.js", () => ({
  sessionProvider: { create: () => undefined, key: { name: "test.session" } },
}));
vi.mock("#context/providers/tool-stubs.js", () => ({
  toolStubProvider: { create: () => undefined, key: { name: "test.toolStubs" } },
}));
vi.mock("#context/providers/sandbox.js", () => ({
  sandboxProvider: { create: () => undefined, key: { name: "test.sandbox" } },
}));

const closeSpy = vi.spyOn(McpConnectionClient.prototype, "close").mockResolvedValue();

const connection: ResolvedConnectionDefinition = {
  connectionName: "echo",
  description: "fake MCP connection",
  logicalPath: "agent/connections/echo.ts",
  protocol: "mcp",
  sourceId: "connections/echo",
  sourceKind: "module",
  url: "http://127.0.0.1:8000/mcp",
};

function contextWithConnection(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    graph: { root: { agent: { connections: [connection], dynamicConnectionResolvers: [] } } },
  } as never);
  return ctx;
}

async function runStepUsingConnection(fail: boolean): Promise<void> {
  const ctx = contextWithConnection();
  const scope = withContextScope(ctx, {} as HarnessSessionBase, async (session) => {
    ctx.require(ConnectionRegistryKey).getClient("echo");
    if (fail) throw new Error("step failed");
    return { result: undefined, session };
  });
  if (fail) {
    await expect(scope).rejects.toThrow("step failed");
  } else {
    await scope;
  }
}

describe("withContextScope connection lifecycle", () => {
  beforeEach(() => {
    closeSpy.mockClear();
  });

  // #4379: each step opens a remote MCP session that nothing closes.
  it.fails("closes the step's connection clients after the step commits", async () => {
    await runStepUsingConnection(false);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it.fails("closes the step's connection clients after the step fails", async () => {
    await runStepUsingConnection(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
