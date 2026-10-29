import { describe, expect, it, vi } from "vitest";

import type { ApprovalContext, ApprovalPolicy } from "#approval/definition.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, type SessionAuthContext } from "#context/keys.js";
import { resolveHeaders } from "#runtime/connections/mcp-client.js";
import { resolveProvidedArguments } from "#runtime/connections/provided-arguments.js";
import { resolveApprovalPolicy } from "#approval/definition.js";
import { once } from "#tools/approval/policies.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type {
  ConnectionCallbackContext,
  ConnectionClient,
  ConnectionPrincipal,
  ConnectionToolMetadata,
} from "#shared/connection-types.js";

import { connectionEntry } from "./connection-entry.js";

const tools: readonly ConnectionToolMetadata[] = [
  {
    annotations: { destructiveHint: true, readOnlyHint: false, title: "Delete issue" },
    description: "Delete an issue.",
    inputSchema: { type: "object" },
    name: "delete_issue",
  },
  { description: "List issues.", inputSchema: { type: "object" }, name: "list_issues" },
];

/** Bob's tracker connection, whose approval policy records each context it receives. */
function setup(
  getToolMetadata: ConnectionClient["getToolMetadata"] = async () => tools,
  decide: ApprovalPolicy = () => "user-approval",
) {
  const seen: ApprovalContext[] = [];
  const policy = vi.fn<ApprovalPolicy>((context) => {
    seen.push(context);
    return decide(context);
  });
  const connection = {
    approval: policy,
    connectionName: "tracker",
    description: "Issue tracker.",
    logicalPath: "connections/tracker.ts",
    protocol: "mcp",
    sourceId: "tracker",
    sourceKind: "module",
    url: "https://tracker.example.com/mcp",
  } as ResolvedConnectionDefinition;
  const client: ConnectionClient = {
    close: async () => {},
    connect: async () => undefined,
    executeTool: async () => {
      throw new Error("Approval never runs the tool.");
    },
    getToolMetadata,
  };
  const registry: ConnectionRegistry = {
    dispose: async () => {},
    getClient: () => client,
    getConnectionApproval: () => policy,
    getConnectionNames: () => ["tracker"],
    getConnections: () => [connection],
  };
  const request = (toolName: string) => {
    const approval = connectionEntry(registry, connection, toolName).approval!;
    const context: ApprovalContext = {
      abortSignal: new AbortController().signal,
      callId: `call-${toolName}`,
      getSandbox: () => Promise.reject(new Error("Approval never opens a sandbox.")),
      session: {} as ApprovalContext["session"],
      toolName: `tracker__${toolName}`,
    };
    return contextStorage.run(new ContextContainer(), () =>
      resolveApprovalPolicy(approval)(context),
    );
  };
  return { request, seen };
}

describe("connection approval context", () => {
  it("passes the annotations the server declared for the called tool", async () => {
    const { request, seen } = setup();
    await expect(request("delete_issue")).resolves.toBe("user-approval");
    expect(seen[0]?.toolAnnotations).toEqual({
      destructiveHint: true,
      readOnlyHint: false,
      title: "Delete issue",
    });
    expect(seen[0]?.toolName).toBe("tracker__delete_issue");
  });

  it("leaves annotations out when the server declared none", async () => {
    const { request, seen } = setup();
    await request("list_issues");
    expect(seen[0]).not.toHaveProperty("toolAnnotations");
  });

  it("still asks the policy when the tools can't be listed", async () => {
    const { request, seen } = setup(async () => {
      throw new Error("tracker is down");
    });
    await expect(request("delete_issue")).resolves.toBe("user-approval");
    expect(seen[0]).not.toHaveProperty("toolAnnotations");
  });

  it("returns a once() decision itself, so the harness can tell it came from once()", async () => {
    const perTool = once();
    const { request } = setup(undefined, perTool);
    expect(await request("delete_issue")).toBe(await perTool({} as ApprovalContext));
  });
});

describe("connection tool call", () => {
  const user = (principalId: string): SessionAuthContext => ({
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId,
    principalType: "user",
  });

  const gateway = {
    getToken: async ({ principal }: { principal: ConnectionPrincipal }) => ({
      token: `token-for-${principal.type === "user" ? principal.id : "app"}`,
    }),
    principalType: "user" as const,
  };

  const subscribe: ConnectionToolMetadata = {
    description: "Subscribe to issue events.",
    inputSchema: { type: "object" },
    name: "subscribe_issues",
  };

  /**
   * Alice's tracker call. Its provided arguments read who approved it and their token; an event
   * action, which sends no arguments, reports who its headers say approved it.
   */
  function call(responder?: SessionAuthContext, toolName = "delete_issue") {
    const connection = {
      connectionName: "tracker",
      description: "Issue tracker.",
      logicalPath: "connections/tracker.ts",
      protocol: "mcp",
      sourceId: "tracker",
      sourceKind: "module",
      toolCall: {
        providedArguments: {
          approvedBy: ({ approval }) => approval?.responder.principalId ?? null,
          approverToken: async ({ approval }) =>
            (await approval?.responder.getToken(gateway))?.token ?? null,
          requestedBy: ({ session }) => session.auth.current?.principalId ?? null,
        },
      },
      headers: (ctx: ConnectionCallbackContext) => ({
        "X-Approved-By": ctx.approval?.responder.principalId ?? "",
      }),
      url: "https://tracker.example.com/mcp",
    } as ResolvedConnectionDefinition;
    const client: ConnectionClient = {
      close: async () => {},
      connect: async () => undefined,
      eventActions: {
        execute: async () => ({
          approvedBy: (await resolveHeaders(connection))["X-Approved-By"],
        }),
        metadata: async () => [subscribe],
        ownsName: (name) => name === subscribe.name,
        recoveryMetadata: () => [subscribe],
      },
      executeTool: async (name, args, options) => ({
        structuredContent: await resolveProvidedArguments({
          args,
          callId: options.callId,
          connection,
          toolName: name,
        }),
      }),
      getToolMetadata: async () => tools,
    };
    const registry: ConnectionRegistry = {
      dispose: async () => {},
      getClient: () => client,
      getConnectionApproval: () => undefined,
      getConnectionNames: () => ["tracker"],
      getConnections: () => [connection],
    };
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: user("alice"), initiator: user("alice") },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    });
    return contextStorage.run(ctx, async () =>
      connectionEntry(registry, connection, toolName).execute!(
        {},
        {
          messages: [],
          toolCallId: "call-1",
          ...(responder !== undefined && { approval: { responder } }),
        },
      ),
    );
  }

  it("gives an approved call's provided arguments its approver and their token", async () => {
    await expect(call(user("bob"))).resolves.toEqual({
      approvedBy: "bob",
      approverToken: "token-for-bob",
      requestedBy: "alice",
    });
  });

  it("gives a call that needed no approval no approver", async () => {
    await expect(call()).resolves.toEqual({
      approvedBy: null,
      approverToken: null,
      requestedBy: "alice",
    });
  });

  it("gives an approved event action's headers its approver", async () => {
    await expect(call(user("bob"), subscribe.name)).resolves.toEqual({ approvedBy: "bob" });
    await expect(call(undefined, subscribe.name)).resolves.toEqual({ approvedBy: "" });
  });
});
