import type { Telemetry } from "ai";
import { describe, expect, it } from "vitest";
import { EXECUTE_TOOL_NAME } from "#protocol/catalog-tools.js";

import { catalogContext, inlineTool, workflowTool } from "#internal/testing/catalog-fixtures.js";

import { toEntryTelemetry } from "./execute-call.js";

interface ToolCall {
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

/** An integration written as a class, so its methods read their state through `this`. */
class RecordingIntegration {
  readonly records: string[] = [];

  onToolExecutionStart(event: { readonly toolCall: ToolCall }): void {
    this.records.push(`start ${event.toolCall.toolName} ${JSON.stringify(event.toolCall.input)}`);
  }

  onToolExecutionEnd(event: { readonly toolCall: ToolCall }): void {
    this.records.push(`end ${event.toolCall.toolName}`);
  }

  executeTool<T>(options: { readonly execute: () => PromiseLike<T>; readonly toolCallId: string }) {
    this.records.push(`executeTool ${options.toolCallId}`);
    return options.execute();
  }
}

/** Reports one tool execution to `telemetry` in the order the AI SDK does. */
async function reportExecution(telemetry: Telemetry, toolCall: ToolCall): Promise<string> {
  await telemetry.onToolExecutionStart?.({ toolCall } as never);
  const output = await telemetry.executeTool!({
    callId: "generation-1",
    execute: async () => "ran",
    toolCallId: toolCall.toolCallId,
  });
  await telemetry.onToolExecutionEnd?.({ output, success: true, toolCall } as never);
  return output;
}

function setup() {
  const { catalog } = catalogContext({
    tools: [
      inlineTool("add"),
      inlineTool("refund_invoice", { deferred: true }),
      workflowTool("deploy_service", "execute", { deferred: true }),
    ],
  });
  const integration = new RecordingIntegration();
  const telemetry = toEntryTelemetry({ integrations: [integration] }, catalog.resolve);
  const [wrapped] = (telemetry?.integrations ?? []) as Telemetry[];
  return { integration, wrapped: wrapped! };
}

describe("toEntryTelemetry", () => {
  it("hides a workflow entry reached through execute, which the harness dispatches after the step", async () => {
    const { integration, wrapped } = setup();

    const output = await reportExecution(wrapped, {
      input: { input: { service: "api" }, tool: "deploy_service" },
      toolCallId: "call-deploy",
      toolName: EXECUTE_TOOL_NAME,
    });

    expect(output).toBe("ran");
    expect(integration.records).toEqual([]);
  });

  it("reports an inline entry reached through execute under its name, with a class integration's this bound", async () => {
    const { integration, wrapped } = setup();

    await reportExecution(wrapped, {
      input: { input: { invoiceId: "in_1" }, tool: "refund_invoice" },
      toolCallId: "call-refund",
      toolName: EXECUTE_TOOL_NAME,
    });

    expect(integration.records).toEqual([
      'start refund_invoice {"invoiceId":"in_1"}',
      "executeTool call-refund",
      "end refund_invoice",
    ]);
  });

  it("reports a direct call unchanged", async () => {
    const { integration, wrapped } = setup();

    await reportExecution(wrapped, { input: { a: 1 }, toolCallId: "call-add", toolName: "add" });

    expect(integration.records).toEqual(['start add {"a":1}', "executeTool call-add", "end add"]);
  });
});
