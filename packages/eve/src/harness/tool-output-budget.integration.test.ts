import { jsonSchema, type LanguageModel, type ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createTestKernel } from "#internal/testing/kernel.js";
import type { HarnessSession } from "#harness/types.js";

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

const REPORT = `Alice's export begins.${"row,".repeat(50_000)}Alice's export ends.`;

function exportModel(): MockLanguageModelV4 {
  const responses: StreamPart[][] = [
    [
      { input: "{}", toolCallId: "export-1", toolName: "export_rows", type: "tool-call" },
      { finishReason: { raw: undefined, unified: "tool-calls" }, type: "finish", usage },
    ],
    [
      { id: "reply", type: "text-start" },
      { delta: "The export is ready.", id: "reply", type: "text-delta" },
      { id: "reply", type: "text-end" },
      { finishReason: { raw: undefined, unified: "stop" }, type: "finish", usage },
    ],
  ];
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream(responses.shift()!) }),
    modelId: "tool-output-budget-model",
    provider: "eve-integration-mock",
  });
}

function exportResultText(prompt: readonly ModelMessage[]): string {
  for (const message of prompt) {
    if (message.role !== "tool" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.output.type === "text") return part.output.value;
    }
  }
  throw new Error("The prompt has no text tool result.");
}

async function runExport(toolOutputTokens?: number | false) {
  const model = exportModel();
  const runStep = createTestKernel({
    agent: { model: { id: "tool-output-budget-model" }, toolOutputTokens },
    resolveModel: async (): Promise<LanguageModel> => model,
    tools: new Map([
      [
        "export_rows",
        {
          description: "Export Alice's rows.",
          execute: async () => REPORT,
          inputSchema: jsonSchema({ type: "object" }),
          name: "export_rows",
        },
      ],
    ]),
  });
  const session: HarnessSession = {
    compaction: {},
    continuationToken: "task:tool-output-budget",
    history: [],
    sessionId: "tool-output-budget",
  };
  const first = await runStep(session, { message: "Export Alice's rows." });
  if (typeof first.next !== "function") throw new TypeError("Expected the tool loop to continue.");
  const second = await first.next(first.session);
  return { model, second };
}

describe("tool output budget", () => {
  it("sends an oversized authored result to the model, and keeps it in history, within the default budget", async () => {
    const { model, second } = await runExport();

    const sent = exportResultText(model.doStreamCalls[1]!.prompt as ModelMessage[]);
    expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(48_000);
    expect(sent.startsWith("Alice's export begins.")).toBe(true);
    expect(sent.endsWith("Alice's export ends.")).toBe(true);
    expect(sent).toMatch(/eve truncated \d+ bytes from the middle of this tool result/);
    expect(exportResultText(second.session.history)).toBe(sent);
  });

  it("sends the result whole when the agent turns the budget off", async () => {
    const { model } = await runExport(false);

    expect(exportResultText(model.doStreamCalls[1]!.prompt as ModelMessage[])).toBe(REPORT);
  });
});
