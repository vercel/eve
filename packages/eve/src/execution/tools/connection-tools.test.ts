import { describe, expect, it, vi } from "vitest";

import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { CallbackBaseUrlKey, isAuthorizationSignal } from "#harness/authorization.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import {
  type ConnectionClient,
  type ConnectionToolMetadata,
  defineInteractiveAuthorization,
} from "#shared/connection-types.js";

import { CONNECTION_EXECUTE_TOOL_NAME } from "./connection-target.js";
import { CONNECTION_SEARCH_TOOL_NAME, resolveConnectionTools } from "./connection-tools.js";

const listIssues: ConnectionToolMetadata = {
  description: "List open issues.",
  inputSchema: { type: "object", properties: {} },
  name: "list_issues",
};

function setup() {
  const startAuthorization = vi.fn(async ({ callbackUrl }: { callbackUrl: string }) => ({
    challenge: { url: `https://idp.example.com/authorize?redirect=${callbackUrl}` },
  }));
  const authorization = defineInteractiveAuthorization({
    getToken: async () => {
      throw new ConnectionAuthorizationRequiredError("unused");
    },
    startAuthorization,
    completeAuthorization: async () => ({ token: "token" }),
  });
  const connections = ["github", "linear", "notion"].map(
    (connectionName) =>
      ({
        authorization: connectionName === "github" ? undefined : authorization,
        connectionName,
        description: connectionName,
        protocol: "mcp",
        url: `https://${connectionName}.example.com/mcp`,
      }) as ResolvedConnectionDefinition,
  );
  const client = (connectionName: string): ConnectionClient => ({
    close: async () => {},
    connect: async () => {},
    executeTool: async () => ({ content: [] }),
    getToolMetadata: async () => {
      if (connectionName === "github") return [listIssues];
      throw new ConnectionAuthorizationRequiredError(connectionName);
    },
  });
  const registry: ConnectionRegistry = {
    dispose: async () => {},
    getClient: client,
    getConnectionApproval: () => undefined,
    getConnectionNames: () => connections.map((connection) => connection.connectionName),
    getConnections: () => connections,
  };

  const ctx = new ContextContainer();
  ctx.set(AuthKey, {
    attributes: {},
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
  });
  ctx.set(SessionIdKey, "connection-tools");
  ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
  ctx.set(ConnectionRegistryKey, registry);

  async function call(toolName: string, input: unknown): Promise<unknown> {
    return await contextStorage.run(ctx, async () => {
      const execute = resolveConnectionTools()?.[toolName]?.execute;
      if (execute === undefined) throw new Error(`${toolName} is not defined.`);
      return await execute(input, { callId: "call-1", messages: [] } as never);
    });
  }

  return { call, startAuthorization };
}

describe("connection tools authorization", () => {
  it("lists unauthorized connections from search and prompts only from execute", async () => {
    const { call, startAuthorization } = setup();
    const signIn = (connection: string) => ({
      connection,
      error: `"${connection}" requires the user to sign in before its tools can be listed. Call connection_execute on "${connection}" to ask the user to sign in, then search again.`,
    });

    const unscoped = await call(CONNECTION_SEARCH_TOOL_NAME, { query: "open issues" });
    expect(isAuthorizationSignal(unscoped)).toBe(false);
    expect(unscoped).toMatchObject({
      tools: [{ connection: "github", tool: "list_issues" }],
      unavailable: [signIn("linear"), signIn("notion")],
    });

    const scoped = await call(CONNECTION_SEARCH_TOOL_NAME, { connection: "linear" });
    expect(scoped).toEqual({ tools: [], total: 0, unavailable: [signIn("linear")] });
    expect(startAuthorization).not.toHaveBeenCalled();

    const executed = await call(CONNECTION_EXECUTE_TOOL_NAME, {
      connection: "linear",
      tool: "list_issues",
    });
    expect(isAuthorizationSignal(executed)).toBe(true);
    expect(executed).toMatchObject({ challenges: [{ name: "linear" }] });
    expect(startAuthorization).toHaveBeenCalledOnce();
  });
});
