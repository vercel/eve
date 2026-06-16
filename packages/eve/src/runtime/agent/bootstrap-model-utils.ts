import type { MockLanguageModelV3 } from "ai/test";

export type BootstrapGenerateOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];
export type BootstrapPrompt = BootstrapGenerateOptions["prompt"];
export type BootstrapGenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
type BootstrapStreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;

const BOOTSTRAP_RESPONSE_TIMESTAMP = new Date("2026-03-16T00:00:00.000Z");

/**
 * Builds a deterministic `doGenerate` result from a text response and token
 * estimates. Shared by the real bootstrap model and the authored-model mock.
 */
export function createBootstrapGenerateResult(input: {
  readonly inputTokens: number;
  readonly modelId: string;
  readonly outputTokens: number;
  readonly text: string;
}): BootstrapGenerateResult {
  return {
    content: [
      {
        text: input.text,
        type: "text",
      },
    ],
    finishReason: { raw: undefined, unified: "stop" },
    response: {
      id: "bootstrap-response",
      modelId: input.modelId,
      timestamp: BOOTSTRAP_RESPONSE_TIMESTAMP,
    },
    usage: {
      inputTokens: {
        cacheRead: 0,
        cacheWrite: 0,
        noCache: input.inputTokens,
        total: input.inputTokens,
      },
      outputTokens: {
        reasoning: 0,
        text: input.outputTokens,
        total: input.outputTokens,
      },
    },
    warnings: [],
  } as unknown as BootstrapGenerateResult;
}

/**
 * Converts a `doGenerate` result into a synchronous `doStream` result by
 * replaying content parts through a `ReadableStream`.
 */
export function createBootstrapStreamResult(
  result: BootstrapGenerateResult,
): BootstrapStreamResult {
  const parts: Record<string, unknown>[] = [
    {
      type: "stream-start",
      warnings: result.warnings,
    },
  ];

  if (result.response !== undefined) {
    parts.push({
      ...result.response,
      type: "response-metadata",
    });
  }

  let textPartIndex = 0;

  for (const part of result.content) {
    switch (part.type) {
      case "text": {
        const id = `text_${textPartIndex}`;
        textPartIndex += 1;

        parts.push({
          id,
          type: "text-start",
        });

        if (part.text.length > 0) {
          parts.push({
            delta: part.text,
            id,
            type: "text-delta",
          });
        }

        parts.push({
          id,
          type: "text-end",
        });
        break;
      }
      case "tool-call":
        parts.push(part as unknown as Record<string, unknown>);
        break;
      default:
        break;
    }
  }

  parts.push({
    finishReason: result.finishReason,
    type: "finish",
    usage: result.usage,
  });

  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }

        controller.close();
      },
    }),
  } as unknown as BootstrapStreamResult;
}

/**
 * Rough token estimate based on character length (1 token per 4 chars).
 */
export function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}

/**
 * Extracts all text from a prompt message's content, joining text parts.
 */
export function getPromptContentText(content: BootstrapPrompt[number]["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .flatMap((part: BootstrapPrompt[number]["content"][number]) => {
      if (typeof part === "string") {
        return [part];
      }

      switch (part.type) {
        case "text":
          return [part.text];
        default:
          return [];
      }
    })
    .join("");
}

/**
 * Returns the text from the last user message in the prompt, or `null`.
 */
export function getLastUserPromptText(prompt: BootstrapPrompt): string | null {
  for (const message of [...prompt].reverse()) {
    if (message.role !== "user") {
      continue;
    }

    const text = getPromptContentText(message.content).trim();

    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

/**
 * Joins all message content in the prompt into a single string.
 */
export function getPromptText(prompt: BootstrapPrompt): string {
  return prompt
    .map((message: BootstrapPrompt[number]) => getPromptContentText(message.content))
    .join(" ");
}
