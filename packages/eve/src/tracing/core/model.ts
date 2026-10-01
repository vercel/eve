import type { Attributes, ContentPart, Usage } from "#tracing/core/types.js";
import { usageAttributes } from "#tracing/core/attributes.js";

export interface ContentSerializer {
  json(value: unknown): string | undefined;
  text(value: string): string | undefined;
  inputMessages(value: unknown): string | undefined;
  instructions(value: unknown): string | undefined;
  outputMessages(value: readonly ContentPart[], finishReason: string): string | undefined;
  toolResults(value: readonly Record<string, unknown>[]): string | undefined;
}

export function modelInputAttributes(
  input: {
    readonly messages: readonly unknown[];
    readonly instructions?: unknown;
  },
  serializer: ContentSerializer,
): Attributes {
  return {
    "gen_ai.input.messages": serializer.inputMessages(input.messages),
    "gen_ai.system_instructions": serializer.instructions(input.instructions),
  };
}

export function modelResultAttributes(
  input: {
    readonly usage: Usage;
    readonly responseId?: string;
    readonly responseModelId?: string;
    readonly finishReason: string;
    readonly content?: readonly ContentPart[];
  },
  serializer: ContentSerializer,
  recordOutputs: boolean,
): Attributes {
  const attributes: Record<string, Attributes[string]> = {
    ...usageAttributes(input.usage, true),
    "gen_ai.response.id": input.responseId,
    "gen_ai.response.model": input.responseModelId,
    "gen_ai.response.finish_reasons": [input.finishReason],
  };
  if (!recordOutputs) return attributes;
  attributes["ai.response.finish_reason"] = input.finishReason;
  const content = input.content;
  if (content === undefined) return attributes;
  attributes["gen_ai.output.messages"] = serializer.outputMessages(content, input.finishReason);
  attributes["ai.response.reasoning"] = serializer.text(
    content
      .filter((part) => part.type === "reasoning")
      .map((part) => part.text)
      .filter((text) => text.trim().length > 0)
      .join("\n"),
  );
  attributes["ai.response.text"] = serializer.text(
    content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  );
  const calls = content
    .filter((part) => part.type === "tool-call")
    .map((part) => ({ callId: part.callId, input: part.input, toolName: part.toolName }));
  if (calls.length > 0) attributes["ai.response.tool_calls"] = serializer.json(calls);
  const results = content
    .filter((part) => part.type === "tool-result" || part.type === "tool-error")
    .map((part) =>
      part.type === "tool-result"
        ? { callId: part.callId, input: part.input, output: part.output, toolName: part.toolName }
        : {
            callId: part.callId,
            input: part.input,
            error: part.error instanceof Error ? part.error.message : part.error,
            toolName: part.toolName,
          },
    );
  if (results.length > 0) attributes["ai.response.tool_results"] = serializer.toolResults(results);
  return attributes;
}
