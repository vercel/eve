import type { ContentPart, Usage } from "../core/types.js";

interface Result {
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  };
  content: readonly unknown[];
}

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
    if (part === null || typeof part !== "object" || !("type" in part)) return [];
    const value = part as {
      type: string;
      text?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    };
    if ((value.type === "text" || value.type === "reasoning") && typeof value.text === "string")
      return [{ type: value.type, text: value.text }];
    if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string") return [];
    const tool = { callId: value.toolCallId, toolName: value.toolName, input: value.input };
    if (value.type === "tool-call") return [{ type: value.type, ...tool }];
    if (value.type === "tool-result") return [{ type: value.type, ...tool, output: value.output }];
    if (value.type === "tool-error") return [{ type: value.type, ...tool, error: value.error }];
    return [];
  });
}
