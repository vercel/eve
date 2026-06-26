import { defineAgent } from "eve";
import { MockLanguageModelV3 } from "ai/test";

type GenerateOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;

const RESPONSE_TIMESTAMP = new Date("2026-06-26T00:00:00.000Z");

const model = new MockLanguageModelV3({
  provider: "eve-stress",
  modelId: "workflow-turns",
  doGenerate: async (options) => createGenerateResult(options),
  doStream: async (options) => createStreamResult(createGenerateResult(options)),
});

export default defineAgent({
  model,
  modelContextWindowTokens: 1_000_000,
});

function createGenerateResult(options: GenerateOptions): GenerateResult {
  const userMessages = options.prompt.filter((message) => message.role === "user");
  const latestMessage = userMessages.at(-1);
  const latestText = latestMessage === undefined ? "" : contentText(latestMessage.content);
  const text = `stress-ack:${userMessages.length}:${latestText}`;
  const inputTokens = estimateTokens(
    options.prompt.map((message) => contentText(message.content)).join(" "),
  );
  const outputTokens = estimateTokens(text);

  return {
    content: [{ text, type: "text" }],
    finishReason: { raw: undefined, unified: "stop" },
    response: {
      id: `stress-response-${userMessages.length}`,
      modelId: model.modelId,
      timestamp: RESPONSE_TIMESTAMP,
    },
    usage: {
      inputTokens: {
        cacheRead: 0,
        cacheWrite: 0,
        noCache: inputTokens,
        total: inputTokens,
      },
      outputTokens: {
        reasoning: 0,
        text: outputTokens,
        total: outputTokens,
      },
    },
    warnings: [],
  };
}

function createStreamResult(result: GenerateResult): StreamResult {
  const text = result.content.find((part) => part.type === "text")?.text ?? "";

  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: result.warnings });
        controller.enqueue({ ...result.response, type: "response-metadata" });
        controller.enqueue({ id: "stress-text", type: "text-start" });
        controller.enqueue({ delta: text, id: "stress-text", type: "text-delta" });
        controller.enqueue({ id: "stress-text", type: "text-end" });
        controller.enqueue({
          finishReason: result.finishReason,
          type: "finish",
          usage: result.usage,
        });
        controller.close();
      },
    }),
  };
}

function contentText(content: GenerateOptions["prompt"][number]["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
