import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, SessionKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { applyCodeModeTool } from "#harness/code-mode.js";
import { buildToolSet, buildToolApproval } from "#harness/tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createStepStartedEvent } from "#protocol/message.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import { resolveConnectionSearchDynamicTools } from "#execution/tools/connection-search.js";
import { always, never, once } from "#tools/approval/policies.js";
import { parseCodeModeWorkflowInput } from "#execution/code-mode/schema.js";
import { codeModeWorkflowReference } from "#execution/code-mode/workflow-reference.js";

const resolver: ResolvedDynamicToolResolver = {
  slug: "connection_search",
  logicalPath: "tools/connection_search.ts",
  sourceId: "tools/connection_search",
  sourceKind: "module",
  events: { "step.started": resolveConnectionSearchDynamicTools },
  eventNames: ["step.started"],
};

const authoredTools = new Map<string, HarnessToolDefinition>([
  [
    "code_mode",
    {
      name: "code_mode",
      description: "Run JavaScript",
      inputSchema: jsonSchema({ type: "object", properties: { js: { type: "string" } } }),
      workflowId: codeModeWorkflowReference.workflowId,
    },
  ],
]);

describe.each(["eager", "lazy"] as const)("%s connection tools in code mode", (mode) => {
  it.each([
    { policy: "unset", approval: undefined, claimed: true },
    { policy: "never", approval: never(), claimed: true },
    { policy: "always", approval: always(), claimed: false },
    { policy: "once", approval: once(), claimed: false },
    { policy: "custom", approval: () => "not-applicable" as const, claimed: false },
  ])(
    "preserves discovery and $policy approval across step serialization",
    async ({ policy, approval, claimed }) => {
      const executeTool = vi.fn(async () => ({ issues: ["issue-1"] }));
      const registry: ConnectionRegistry = {
        dispose: async () => {},
        getConnectionApproval: () => approval,
        getConnectionNames: () => ["linear"],
        getConnections: () => [
          {
            connectionName: "linear",
            description: "Issue tracker",
            logicalPath: "connections/linear.ts",
            protocol: "mcp",
            sourceId: "connections/linear",
            sourceKind: "module",
            url: "https://linear.example/mcp",
          },
        ],
        getClient: () => ({
          close: async () => {},
          connect: async () => {},
          executeTool,
          getTools: async () => ({}),
          getToolMetadata: async () => [
            { name: "list_issues", description: "List issues", inputSchema: { type: "object" } },
          ],
        }),
      };
      function provide(ctx: ContextContainer) {
        ctx.setVirtualContext(ConnectionRegistryKey, registry);
        ctx.setVirtualContext(SessionKey, {
          sessionId: "session",
          auth: { current: null, initiator: null },
          turn: { id: "turn", sequence: 0 },
        });
      }
      async function step(ctx: ContextContainer, stepIndex: number) {
        provide(ctx);
        await contextStorage.run(ctx, () =>
          dispatchDynamicToolEvent({
            ctx,
            event: createStepStartedEvent({
              modelId: "test",
              sequence: stepIndex,
              stepIndex,
              turnId: "turn",
            }),
            messages: [],
            resolvers: [resolver],
          }),
        );
        const harnessTools = buildResponseAuthorizationTools({ authoredTools, context: ctx });
        return applyCodeModeTool({
          continuationSecurity: { signingKey: "test" },
          harnessTools,
          mode,
          tools: buildToolSet({ tools: harnessTools }),
        });
      }

      const parent = new ContextContainer();
      parent.set(SessionIdKey, "session");
      const first = await step(parent, 0);
      expect(Object.keys(first.modelTools).sort()).toEqual(["code_mode", "connection_search"]);
      expect(first.claimedToolNames).toEqual([]);
      await contextStorage.run(parent, () =>
        first.modelTools.connection_search!.execute!({ keywords: "issues" } as never, {
          context: {},
          toolCallId: "search",
          messages: [],
        }),
      );

      const next = await deserializeContext(JSON.parse(JSON.stringify(serializeContext(parent))));
      const second = await step(next, 1);
      expect(second.claimedToolNames).toEqual(claimed ? ["linear__list_issues"] : []);
      expect(Object.keys(second.modelTools).sort()).toEqual(
        claimed && mode === "lazy"
          ? ["code_mode", "connection_search"]
          : ["code_mode", "connection_search", "linear__list_issues"],
      );
      expect(executeTool).not.toHaveBeenCalled();

      if (!claimed) {
        const check = buildToolApproval(second.modelTools);
        if (typeof check !== "function") throw new Error("Expected an approval policy");
        await expect(
          contextStorage.run(next, () =>
            check({
              toolCall: { toolName: "linear__list_issues", input: {}, toolCallId: "call" },
            } as never),
          ),
        ).resolves.toBe(policy === "custom" ? "not-applicable" : "user-approval");
        return;
      }
      const pinned = parseCodeModeWorkflowInput(
        second.harnessTools.get("code_mode")!.executeInput!({
          js: "return await tools.linear__list_issues({});",
        }),
      );
      expect(pinned.toolNames).toEqual(["linear__list_issues"]);
      expect(pinned.mode).toBe(mode);

      const nested = await deserializeContext(JSON.parse(JSON.stringify(serializeContext(next))));
      provide(nested);
      const nestedTools = buildResponseAuthorizationTools({ authoredTools, context: nested });
      await expect(
        contextStorage.run(nested, () =>
          nestedTools.get("linear__list_issues")!.execute!(
            {},
            { toolCallId: "nested-call", messages: [] },
          ),
        ),
      ).resolves.toEqual({ issues: ["issue-1"] });
      expect(executeTool).toHaveBeenCalledExactlyOnceWith(
        "list_issues",
        {},
        expect.objectContaining({ callId: "nested-call" }),
      );
    },
  );
});
