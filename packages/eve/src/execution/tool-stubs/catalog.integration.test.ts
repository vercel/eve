import { describe, expect, it } from "vitest";

import { SessionKey, ToolStubsKey } from "#context/keys.js";
import { toolStubProvider } from "#context/providers/tool-stubs.js";
import { workflowEntry } from "#execution/session/entry.js";
import { buildToolSet } from "#harness/tools.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  catalogContext,
  connectionTool,
  fakeConnection,
  inlineTool,
} from "#internal/testing/catalog-fixtures.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { start } from "#internal/workflow/runtime.js";
import { CALL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { STUB_CONTEXT_KEY, type ToolStub } from "#tool-stubs/types.js";
import type { ToolExecuteOptions } from "#tools/definition.js";

/** The last value a tool execution produced, as the AI SDK records it. */
async function settle(output: unknown): Promise<unknown> {
  if (!isAsyncIterable(output)) return await output;
  let last: unknown;
  for await (const value of output) last = value;
  return last;
}

describe("tool stubs through eve__tool", () => {
  it("match the entry an eve__tool call reaches, by its name and input, and leave other calls live", async () => {
    const rules: readonly ToolStub[] = [
      {
        id: "refund",
        tool: "refund_invoice",
        match: { invoiceId: { const: "inv_1" } },
        outcome: { response: { refunded: "stubbed" } },
      },
      {
        id: "open-issues",
        tool: "linear__list_issues",
        match: { status: { const: "open" } },
        outcome: { response: { issues: ["Fix login"] } },
      },
    ];
    const linear = fakeConnection({
      description: "Linear issues.",
      name: "linear",
      tools: [
        connectionTool("list_issues", {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
        }),
      ],
    });
    const runtime = await createTestRuntime();
    await runtime.run(async () => {
      const token = "catalog-stub-playback";
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
        const {
          catalog,
          ctx,
          run: inSession,
        } = catalogContext({
          connections: [linear],
          tools: [
            inlineTool("refund_invoice", {
              deferred: true,
              schema: {
                type: "object",
                properties: { invoiceId: { type: "string" } },
                required: ["invoiceId"],
              },
            }),
          ],
        });
        ctx.set(SessionKey, {
          auth: { current: null, initiator: null },
          sessionId: run.runId,
          turn: { id: "turn-0", sequence: 0 },
        });
        ctx.set(ToolStubsKey, { rootSessionId: run.runId, rules, token });
        ctx.setVirtualContext(toolStubProvider.key, toolStubProvider.create(ctx)!.value);
        const execute = buildToolSet({
          describe: (definition) => definition.description,
          resolve: catalog.resolve,
          tools: catalog.advertised,
        })[CALL_TOOL_NAME]!.execute as (input: unknown, options: ToolExecuteOptions) => unknown;
        const call = (toolCallId: string, input: Record<string, unknown>) =>
          inSession(async () => await settle(execute(input, { messages: [], toolCallId })));

        expect(
          await call("refund-1", { name: "refund_invoice", input: { invoiceId: "inv_1" } }),
        ).toEqual({ refunded: "stubbed" });
        expect(
          await call("refund-2", { name: "refund_invoice", input: { invoiceId: "inv_2" } }),
        ).toEqual({ input: { invoiceId: "inv_2" }, ran: "refund_invoice" });

        expect(
          await call("issues-1", { name: "linear__list_issues", input: { status: "open" } }),
        ).toEqual({ issues: ["Fix login"] });
        expect(linear.calls).toEqual([]);
        await call("issues-2", { name: "linear__list_issues", input: { status: "closed" } });
        expect(linear.calls).toEqual([{ input: { status: "closed" }, tool: "list_issues" }]);
      } finally {
        await run.cancel();
      }
    });
  });
});
