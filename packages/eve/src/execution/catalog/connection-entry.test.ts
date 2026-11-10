import { describe, expect, it, vi } from "vitest";

import type { ApprovalContext, ApprovalPolicy } from "#approval/definition.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, type SessionAuthContext } from "#context/keys.js";
import { resolveHeaders } from "#runtime/connections/mcp-client.js";
import { resolveProvidedArguments } from "#runtime/connections/provided-arguments.js";
import { resolveApprovalPolicy } from "#approval/definition.js";
import { evaluateApproval, rememberDecision, type ApprovalMemory } from "#approval/evaluation.js";
import { once } from "#tools/approval/policies.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type {
  ConnectionCallbackContext,
  ConnectionClient,
  ConnectionPrincipal,
  ConnectionToolMetadata,
} from "#shared/connection-types.js";
import type { ToolSchema } from "#tools/schema.js";

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
      session: {
        auth: { current: null, initiator: null, sender: null },
      } as ApprovalContext["session"],
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

describe("a connection that acts as the caller, after someone else spoke", () => {
  const user = (principalId: string): SessionAuthContext => ({
    attributes: {},
    authenticator: "test",
    principalId,
    principalType: "user",
  });
  const [alice, bob] = [user("alice"), user("bob")];
  const userScoped = { getToken: async () => ({ token: "t" }), principalType: "user" } as const;

  /** Decides one call to Alice's tracker the way the harness does, with `sender` last to speak. */
  function decide(
    connection: Partial<ResolvedConnectionDefinition>,
    sender: SessionAuthContext,
    memory?: ApprovalMemory,
  ) {
    const resolved = {
      authorization: userScoped,
      connectionName: "tracker",
      description: "Issue tracker.",
      logicalPath: "connections/tracker.ts",
      protocol: "mcp",
      sourceId: "tracker",
      sourceKind: "module",
      url: "https://tracker.example.com/mcp",
      ...connection,
    } as ResolvedConnectionDefinition;
    const client: ConnectionClient = {
      close: async () => {},
      connect: async () => undefined,
      executeTool: async () => {
        throw new Error("Approval never runs the tool.");
      },
      getToolMetadata: async () => tools,
    };
    const registry: ConnectionRegistry = {
      dispose: async () => {},
      getClient: () => client,
      getConnectionApproval: () => undefined,
      getConnectionNames: () => ["tracker"],
      getConnections: () => [resolved],
    };
    const approval = connectionEntry(registry, resolved, "list_issues").approval!;
    const context: ApprovalContext = {
      abortSignal: new AbortController().signal,
      callId: "call-list",
      getSandbox: () => Promise.reject(new Error("Approval never opens a sandbox.")),
      session: { auth: { current: alice, initiator: alice, sender } } as ApprovalContext["session"],
      toolName: "tracker__list_issues",
    };
    return contextStorage.run(new ContextContainer(), () =>
      evaluateApproval(resolveApprovalPolicy(approval), context, { memory }),
    );
  }

  it("asks the caller, and only the caller can approve", async () => {
    expect(await decide({}, bob)).toEqual({
      awaitsPerson: true,
      callerApproves: true,
      denied: false,
    });
  });

  it.each([
    ["the caller spoke last", {}, alice],
    [
      "the connection uses the agent's own credentials",
      { authorization: { ...userScoped, principalType: "app" as const } },
      bob,
    ],
  ])("doesn't ask when %s", async (_, connection, sender) => {
    expect(await decide(connection, sender)).toEqual({ denied: false });
  });

  it("still asks after a policy's own clearance, and keeps its denial", async () => {
    expect(await decide({ approval: () => "approved" }, bob)).toMatchObject({ awaitsPerson: true });
    expect(await decide({ approval: () => "denied" }, bob)).toMatchObject({ denied: true });
  });

  it("runs on a mismatch helper's remembered approval, cleared for the caller's token", async () => {
    const approval = once({ when: "principal-mismatch" });
    const asked = await decide({ approval }, bob);
    const memory = {
      pending: [],
      remembered: rememberDecision(
        {},
        { interactionId: "approval-1", remember: asked.remember },
        "accepted",
      ),
    };
    expect(await decide({ approval }, bob, memory)).toMatchObject({
      callerConfirmed: true,
      denied: false,
    });
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
      auth: { current: user("alice"), initiator: user("alice"), sender: user("alice") },
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

describe("connection tool calls", () => {
  it("runs a call whose omitted argument defaults to null", async () => {
    // Pydantic publishes `query: str = None` as a string property that defaults to null.
    const search: ConnectionToolMetadata = {
      description: "Search issues.",
      inputSchema: { properties: { query: { default: null, type: "string" } }, type: "object" },
      name: "search_issues",
    };
    const executeTool = vi.fn<ConnectionClient["executeTool"]>(async () => ({ content: [] }));
    const connection = {
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
      executeTool,
      getToolMetadata: async () => [search],
    };
    const registry: ConnectionRegistry = {
      dispose: async () => {},
      getClient: () => client,
      getConnectionApproval: () => undefined,
      getConnectionNames: () => ["tracker"],
      getConnections: () => [connection],
    };
    const entry = connectionEntry(registry, connection, "search_issues");

    // The harness validates the model's input, then runs the tool on the validated value.
    await contextStorage.run(new ContextContainer(), async () => {
      const checked = await (entry.inputSchema as ToolSchema)["~standard"].validate({});
      expect(checked).toEqual({ value: {} });
      await entry.execute!((checked as { value: unknown }).value, {
        messages: [],
        toolCallId: "call-search",
      });
    });

    expect(executeTool).toHaveBeenCalledWith(
      "search_issues",
      { query: null },
      expect.objectContaining({ callId: "call-search" }),
    );
  });
});
