import { toolStubProvider } from "#context/providers/tool-stubs.js";
import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, ToolStubsKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { workflowEntry } from "#execution/session/entry.js";
import { resolveConnectionTools } from "#execution/tools/connection-tools.js";
import { calledTool } from "#evals/assertions/run.js";
import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import type { EveEvalTaskResult } from "#evals/types.js";
import { emitNestedToolActions } from "#harness/nested-actions.js";
import { stampTestEvents } from "#internal/testing/events.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { recordToolStubFailure } from "#tool-stubs/execute.js";
import { readStubFailure } from "#execution/tool-stubs/steps.js";
import { STUB_CONTEXT_KEY, STUB_FAILURE_NAMESPACE, type ToolStub } from "#tool-stubs/types.js";
import type { ConnectionClient } from "#shared/connection-types.js";
import type { ToolContext } from "#tools/definition.js";

describe("connection operation stubs", () => {
  it("reports child-scoped failures and recovery, validates input, and executes unmatched calls", async () => {
    let liveCalls = 0;
    const runtime = await createTestRuntime();
    await runtime.run(async () => {
      const rules: readonly ToolStub[] = [
        {
          id: "open",
          tool: "researcher/linear__list_issues",
          match: { status: { const: "open" } },
          outcomes: [
            { throw: { name: "TimeoutError", message: "Issue service timed out" } },
            { throw: { name: "ConnectionAuthorizationRequiredError", message: "Access denied" } },
            { response: { issues: ["milk"] } },
          ],
        },
      ];
      const token = "connection-stub-playback";
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {},
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: { token, rules },
          },
        },
      ]);
      try {
        await waitForHook({ runId: run.runId }, { token });
        const client: ConnectionClient = {
          close: async () => {},
          connect: async () => {},
          getToolMetadata: async () => [
            {
              name: "list_issues",
              description: "List issues.",
              inputSchema: {
                type: "object",
                properties: { status: { type: "string" } },
                required: ["status"],
              },
            },
          ],
          executeTool: async () => {
            liveCalls++;
            return { content: [{ type: "text", text: "live" }] };
          },
        };
        const connection = {
          sourceId: "test:linear",
          sourceKind: "module" as const,
          logicalPath: "connections/linear.ts",
          connectionName: "linear",
          description: "Issues",
          protocol: "mcp" as const,
          url: "https://linear.example/mcp",
        };
        const context = new ContextContainer();
        context.set(SessionKey, {
          sessionId: run.runId,
          auth: { current: null, initiator: null },
          turn: { id: "turn-0", sequence: 0 },
        });
        context.set(ToolStubsKey, {
          token,
          rules,
          rootSessionId: run.runId,
          agentPath: "researcher",
        });
        context.set(ConnectionRegistryKey, {
          dispose: async () => {},
          getClient: () => client,
          getConnectionApproval: () => undefined,
          getConnectionNames: () => ["linear"],
          getConnections: () => [connection],
        });
        context.setVirtualContext(toolStubProvider.key, toolStubProvider.create(context)!.value);
        await contextStorage.run(context, async () => {
          const execute = resolveConnectionTools()!.connection_execute!.execute!;
          const events: UnstampedMessageStreamEvent[] = [];
          const call = async (callId: string, input: unknown) => {
            try {
              return await execute({ connection: "linear", tool: "list_issues", input }, {
                callId,
              } as ToolContext);
            } finally {
              await emitNestedToolActions(
                async (event) => {
                  events.push(event);
                },
                { sequence: 0, stepIndex: 0, turnId: "turn-0" },
                callId,
              );
            }
          };
          const evalResult = (): EveEvalTaskResult => {
            const stamped = stampTestEvents(events);
            return {
              events: stamped,
              derived: deriveRunFacts(stamped),
              status: "completed",
              output: null,
              finalMessage: null,
              traceContexts: [],
            };
          };
          await expect(call("invalid", { status: 42 })).rejects.toThrow(/Invalid input/);
          await expect(call("failed", { status: "open" })).rejects.toMatchObject({
            name: "TimeoutError",
            message: "Issue service timed out",
          });
          expect(
            await calledTool("linear__list_issues", {
              status: "failed",
              input: { status: "open" },
              output: "Issue service timed out",
              count: 1,
            }).evaluate(evalResult()),
          ).toMatchObject({ score: 1 });
          expect(events[0]).toMatchObject({
            type: "actions.requested",
            data: {
              actions: [{ parentCallId: "failed", toolName: "linear__list_issues" }],
            },
          });
          expect(await readStubFailure(run.runId)).toBeUndefined();
          expect(liveCalls).toBe(0);
          await expect(call("auth-named-failure", { status: "open" })).rejects.toMatchObject({
            name: "ConnectionAuthorizationRequiredError",
            message: "Access denied",
          });
          expect(
            await calledTool("linear__list_issues", {
              status: "failed",
              output: "Access denied",
              count: 1,
            }).evaluate(evalResult()),
          ).toMatchObject({ score: 1 });
          expect(await call("stubbed", { status: "open", limit: 10 })).toEqual({
            issues: ["milk"],
          });
          expect(
            await calledTool("linear__list_issues", {
              status: "completed",
              input: { status: "open", limit: 10 },
              output: { issues: ["milk"] },
              count: 1,
            }).evaluate(evalResult()),
          ).toMatchObject({ score: 1 });
          expect(liveCalls).toBe(0);
          await call("live", { status: "closed" });
          expect(liveCalls).toBe(1);
          // connection_execute converts the operation's output before the model receives it.
          await recordToolStubFailure("connection_execute", "live");
          expect(await readStubFailure(run.runId)).toBeUndefined();
          const world = await getWorld();
          const append = world.streams.write.bind(world.streams);
          const failureSuffix = Buffer.from(STUB_FAILURE_NAMESPACE).toString("base64url");
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const write = vi.spyOn(world.streams, "write").mockImplementation(async (...args) => {
            if (args[1].endsWith(`_${failureSuffix}`)) {
              entered.resolve();
              await release.promise;
            }
            return await append(...args);
          });
          let acknowledged = false;
          const recording = recordToolStubFailure("connection_execute", "stubbed").then(() => {
            acknowledged = true;
          });
          try {
            await entered.promise;
            expect(acknowledged).toBe(false);
            expect(await readStubFailure(run.runId)).toBeUndefined();
            release.resolve();
            await recording;
            expect(await readStubFailure(run.runId)).toBe(
              'Stubbed tool "connection_execute" failed during output processing.',
            );
          } finally {
            release.resolve();
            await recording;
            write.mockRestore();
          }
        });
      } finally {
        await run.cancel();
      }
    });
  });
});
