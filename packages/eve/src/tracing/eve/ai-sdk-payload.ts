import type { Telemetry } from "ai";
import type { ContentPart, Usage } from "#tracing/lib/index.js";

type Result = Parameters<NonNullable<Telemetry["onLanguageModelCallEnd"]>>[0];

export function modelUsage(usage: Result["usage"]): Usage {
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    inputTokenDetails: Object.freeze({
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
    }),
  });
}

export function modelContent(content: Result["content"]): readonly ContentPart[] {
  return content.flatMap((part): ContentPart[] => {
    switch (part.type) {
      case "text":
      case "reasoning":
        return [{ type: part.type, text: part.text }];
      case "tool-call":
        return [
          { type: part.type, callId: part.toolCallId, toolName: part.toolName, input: part.input },
        ];
      case "tool-result":
        return [
          {
            type: part.type,
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            output: part.output,
          },
        ];
      case "tool-error":
        return [
          {
            type: part.type,
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            error: part.error,
          },
        ];
      default:
        return [];
    }
  });
}
