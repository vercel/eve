import { describe, expect, it, vi } from "vitest";

import type { ApprovalContext, ApprovalPolicy } from "#approval/definition.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { resolveApprovalPolicy } from "#approval/definition.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionClient, ConnectionToolMetadata } from "#shared/connection-types.js";

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
function setup(getToolMetadata: ConnectionClient["getToolMetadata"] = async () => tools) {
  const seen: ApprovalContext[] = [];
  const policy = vi.fn<ApprovalPolicy>((context) => {
    seen.push(context);
    return "user-approval";
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
      approvedTools: new Set<string>(),
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
});
