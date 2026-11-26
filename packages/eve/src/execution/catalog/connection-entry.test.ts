import { describe, expect, it, vi } from "vitest";

import type {
  ApprovalContext,
  ApprovalPolicy,
  ApprovalResponseContext,
  ApprovalResponseDecision,
} from "#approval/definition.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey, SessionKey, type SessionAuthContext } from "#context/keys.js";
import { toolCallModelOutput } from "#harness/tool-call-io.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { offloadContent } from "#tools/offload-content.js";
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
import type { ToolSchema } from "#tools/schema.js";

import { EVENT_SUBSCRIBE_ACTION } from "#runtime/subscriptions/actions.js";

import {
  connectionEntry,
  connectionEventActionApproval,
  runConnectionEventAction,
} from "./connection-entry.js";

const tools: readonly ConnectionToolMetadata[] = [
  {
    annotations: { destructiveHint: true, readOnlyHint: false, title: "Delete issue" },
    description: "Delete an issue.",
    inputSchema: { type: "object" },
    name: "delete_issue",
  },
  { description: "List issues.", inputSchema: { type: "object" }, name: "list_issues" },
];

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
  return { connection, request, seen };
}

describe("event action approval", () => {
  it("applies the connection's policy without listing the connection's tools", async () => {
    const getToolMetadata = vi.fn<ConnectionClient["getToolMetadata"]>(async () => tools);
    const { connection } = setup(getToolMetadata);
    const approval = connectionEventActionApproval(connection)!;
    const context: ApprovalContext = {
      abortSignal: new AbortController().signal,
      callId: "call-subscribe",
      getSandbox: () => Promise.reject(new Error("Approval never opens a sandbox.")),
      session: {} as ApprovalContext["session"],
      toolName: "eve__subscribe",
    };

    const status = await contextStorage.run(new ContextContainer(), () =>
      resolveApprovalPolicy(approval)(context),
    );

    expect(status).toBe("user-approval");
    expect(getToolMetadata).not.toHaveBeenCalled();
  });
});

describe("event action approval combined with the agent's approval", () => {
  const callId = "call-subscribe";

  function combined(instanceId: string) {
    const { connection } = setup();
    const response = vi.fn(async (): Promise<ApprovalResponseDecision> => ({ status: "allowed" }));
    const configured: ResolvedConnectionDefinition = {
      ...connection,
      approval: { request: () => "approved", response },
      instanceId,
    };
    const approval = connectionEventActionApproval(configured, () => "user-approval");
    if (typeof approval !== "object") throw new Error("Expected an approval configuration.");
    const request: ApprovalContext = {
      abortSignal: new AbortController().signal,
      callId,
      getSandbox: () => Promise.reject(new Error("Approval never opens a sandbox.")),
      session: {} as ApprovalContext["session"],
      toolName: "eve__subscribe",
    };
    const answer = { request: { callId } } as ApprovalResponseContext;
    return { answer, approval, configured, request, response };
  }

  it("asks for approval when the agent does, even though the connection's policy approves", async () => {
    const { approval, request } = combined("tracker-a");

    const status = await contextStorage.run(new ContextContainer(), () =>
      approval.request(request),
    );

    expect(status).toBe("user-approval");
  });

  it("pins the instance it asked about, so the connection's response runs for it", async () => {
    const { answer, approval, request, response } = combined("tracker-a");

    const decision = await contextStorage.run(new ContextContainer(), async () => {
      await approval.request(request);
      return approval.response?.(answer);
    });

    expect(decision).toEqual({ status: "allowed" });
    expect(response).toHaveBeenCalledOnce();
  });

  it("rejects the response when the connection resolves to another instance by then", async () => {
    const { answer, approval, configured, request, response } = combined("tracker-a");

    const decision = await contextStorage.run(new ContextContainer(), async () => {
      await approval.request(request);
      Object.assign(configured, { instanceId: "tracker-b" });
      return approval.response?.(answer);
    });

    expect(decision).toEqual({
      reason: expect.stringContaining(
        "The connection for this tool call changed or is unavailable.",
      ),
      status: "rejected",
    });
    expect(response).not.toHaveBeenCalled();
  });
});

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
        getEvents: async () => [],
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
    const options = {
      messages: [],
      toolCallId: "call-1",
      ...(responder !== undefined && { approval: { responder } }),
    };
    return contextStorage.run(ctx, async () =>
      toolName === EVENT_SUBSCRIBE_ACTION
        ? runConnectionEventAction(registry, connection, toolName, {}, options)
        : connectionEntry(registry, connection, toolName).execute!({}, options),
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
    await expect(call(user("bob"), EVENT_SUBSCRIBE_ACTION)).resolves.toEqual({ approvedBy: "bob" });
    await expect(call(undefined, EVENT_SUBSCRIBE_ACTION)).resolves.toEqual({ approvedBy: "" });
  });
});

describe("connection tool calls", () => {
  it("runs a call whose omitted argument defaults to null", async () => {
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

describe("connection tool model output", () => {
  const listIssues: ConnectionToolMetadata = {
    description: "List issues.",
    inputSchema: { type: "object" },
    name: "list_issues",
  };
  const issues = Array.from({ length: 60 }, (_, number) => ({ body: "x".repeat(200), number }));

  async function modelOutput(
    toolCall: ResolvedConnectionDefinition["toolCall"],
    content: readonly unknown[] = [{ text: JSON.stringify(issues), type: "text" }],
  ) {
    const connection = {
      connectionName: "tracker",
      description: "Issue tracker.",
      logicalPath: "connections/tracker.ts",
      protocol: "mcp",
      sourceId: "tracker",
      sourceKind: "module",
      toolCall,
      url: "https://tracker.example.com/mcp",
    } as ResolvedConnectionDefinition;
    const client: ConnectionClient = {
      close: async () => {},
      connect: async () => undefined,
      executeTool: async () => ({ content }),
      getToolMetadata: async () => [listIssues],
    };
    const registry: ConnectionRegistry = {
      dispose: async () => {},
      getClient: () => client,
      getConnectionApproval: () => undefined,
      getConnectionNames: () => ["tracker"],
      getConnections: () => [connection],
    };
    const { access, files } = mockSandbox();
    const ctx = new ContextContainer();
    ctx.setVirtualContext(SandboxKey, access);
    const entry = connectionEntry(registry, connection, "list_issues");
    const output = await contextStorage.run(ctx, async () => {
      const result = await entry.execute!({}, { messages: [], toolCallId: "call-1" });
      return await toolCallModelOutput(entry, result, "call-1");
    });
    return { files, output };
  }

  it("offloads a large result when the connection sets toolCall.toModelOutput", async () => {
    const { files, output } = await modelOutput({
      toModelOutput: offloadContent({ maxBytes: 4_000 }),
    });
    expect(output.type).toBe("text");
    expect((output as { value: string }).value).toContain(
      "/tmp/.eve/tool-results/tracker__list_issues-call-1.json",
    );
    expect([...files.values()]).toEqual([JSON.stringify(issues)]);
  });

  it("keeps an image block as a file part and writes nothing", async () => {
    const { files, output } = await modelOutput(
      { toModelOutput: offloadContent({ maxBytes: 10 }) },
      [
        { text: "x".repeat(200), type: "text" },
        { data: "AAAA", mimeType: "image/png", type: "image" },
      ],
    );
    expect(output.type).toBe("content");
    expect((output as { value: { type: string }[] }).value.map((part) => part.type)).toContain(
      "file",
    );
    expect(files.size).toBe(0);
  });

  it("sends the whole result when the connection sets no toolCall.toModelOutput", async () => {
    const { files, output } = await modelOutput(undefined);
    expect(output).toEqual({ type: "json", value: issues });
    expect(files.size).toBe(0);
  });
});
