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
  const authorization = {
    ...defineInteractiveAuthorization({
      getToken: async () => {
        throw new ConnectionAuthorizationRequiredError("unused");
      },
      startAuthorization,
      completeAuthorization: async () => ({ token: "token" }),
    }),
    vercelConnect: { connector: "workspace/agent" },
  };
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
  it("prompts only for one named connection with signIn, never for a plain search", async () => {
    const { call, startAuthorization } = setup();
    const signIn = (connection: string) => ({
      connection,
      error: `Sign-in required: the user has not signed in to "${connection}", so its tools cannot be listed. If the request needs "${connection}", call connection_search with connection "${connection}" and signIn: true to ask the user to sign in.`,
      requiresSignIn: true,
    });

    const unscoped = await call(CONNECTION_SEARCH_TOOL_NAME, { query: "open issues" });
    expect(isAuthorizationSignal(unscoped)).toBe(false);
    expect(unscoped).toMatchObject({
      tools: [{ connection: "github", tool: "list_issues" }],
      unavailable: [signIn("linear"), signIn("notion")],
    });
    const scoped = await call(CONNECTION_SEARCH_TOOL_NAME, { connection: "linear" });
    expect(scoped).toEqual({ tools: [], total: 0, unavailable: [signIn("linear")] });
    await expect(call(CONNECTION_SEARCH_TOOL_NAME, { signIn: true })).rejects.toThrow(
      "connection_search with signIn: true requires `connection`.",
    );
    const signedIn = await call(CONNECTION_SEARCH_TOOL_NAME, {
      connection: "github",
      query: "issues",
      signIn: true,
    });
    expect(signedIn).toMatchObject({ tools: [{ tool: "list_issues" }], total: 1 });
    expect(startAuthorization).not.toHaveBeenCalled();

    const requested = await call(CONNECTION_SEARCH_TOOL_NAME, {
      connection: "linear",
      query: "issues",
      signIn: true,
    });
    expect(requested).toMatchObject({
      challenges: [
        { grant: "workspace/agent", name: "linear", requester: { principalId: "alice" } },
      ],
    });
    expect(startAuthorization).toHaveBeenCalledOnce();

    const executed = await call(CONNECTION_EXECUTE_TOOL_NAME, {
      connection: "notion",
      tool: "list_issues",
    });
    expect(executed).toMatchObject({ challenges: [{ name: "notion" }] });
    expect(startAuthorization).toHaveBeenCalledTimes(2);
  });
});
