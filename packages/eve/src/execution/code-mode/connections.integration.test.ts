import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, SessionKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { applyCodeModeTool } from "#harness/code-mode.js";
import { buildToolSet, evaluateToolApproval } from "#harness/tools.js";
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

describe("connection tools in code mode", () => {
  // Every discovered connection tool is claimed; the nested step evaluates the
  // restored policy the way a direct call would.
  it.each([
    { policy: "unset", approval: undefined, decision: undefined },
    { policy: "never", approval: never(), decision: "not-applicable" },
    { policy: "always", approval: always(), decision: "user-approval" },
    { policy: "once", approval: once(), decision: "user-approval" },
    {
      policy: "custom",
      approval: () => "not-applicable" as const,
      decision: "not-applicable",
    },
  ])(
    "preserves discovery and $policy approval across step serialization",
    async ({ approval, decision }) => {
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
          tools: buildToolSet({ tools: harnessTools }),
        });
      }

      const parent = new ContextContainer();
      parent.set(SessionIdKey, "session");
      const first = await step(parent, 0);
      expect(Object.keys(first.modelTools).sort()).toEqual(["code_mode", "connection_search"]);
      await contextStorage.run(parent, () =>
        first.modelTools.connection_search!.execute!({ keywords: "issues" } as never, {
          context: {},
          toolCallId: "search",
          messages: [],
        }),
      );

      const next = await deserializeContext(JSON.parse(JSON.stringify(serializeContext(parent))));
      const second = await step(next, 1);
      expect(Object.keys(second.modelTools).sort()).toEqual(["code_mode", "connection_search"]);
      expect(executeTool).not.toHaveBeenCalled();

      const pinned = parseCodeModeWorkflowInput(
        second.harnessTools.get("code_mode")!.executeInput!({
          js: "return await tools.linear__list_issues({});",
        }),
      );
      const claimed = pinned.toolCatalog.filter((entry) => entry.target !== "direct");
      expect(claimed.map((entry) => entry.name)).toEqual(["linear__list_issues"]);

      const nested = await deserializeContext(JSON.parse(JSON.stringify(serializeContext(next))));
      provide(nested);
      const nestedTools = buildResponseAuthorizationTools({ authoredTools, context: nested });
      // The restored policy answers inside the nested step the way it would
      // for a direct call.
      await expect(
        contextStorage.run(nested, () =>
          evaluateToolApproval(nestedTools.get("linear__list_issues")!, {
            approvedTools: new Set(),
            callId: "nested-call",
            toolInput: {},
          }),
        ),
      ).resolves.toBe(decision);
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
