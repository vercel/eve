import { getToolName, isDynamicToolUIPart } from "ai";
import type { UIMessage } from "ai";
import type { EveDynamicToolPart } from "eve/vue";

export type SaveMemoryDisplayPart = {
  kind: "save_memory";
  parts: EveDynamicToolPart[];
};

export type MessageDisplayPart = {
  kind: "message";
  part: UIMessage["parts"][number];
};

export type DisplayPart = MessageDisplayPart | SaveMemoryDisplayPart;

export function buildDisplayParts(parts: UIMessage["parts"]): DisplayPart[] {
  const display: DisplayPart[] = [];
  let buffer: EveDynamicToolPart[] = [];

  function flush() {
    if (!buffer.length) {
      return;
    }

    display.push({
      kind: "save_memory",
      parts: buffer.length === 1 ? [buffer[0]!] : [...buffer],
    });
    buffer = [];
  }

  for (const part of parts) {
    if (isDynamicToolUIPart(part) && getToolName(part) === "save_memory") {
      buffer.push(part as EveDynamicToolPart);
      continue;
    }

    flush();
    display.push({ kind: "message", part });
  }

  flush();
  return display;
}

export interface SaveMemoryUpdate {
  category?: string;
  content?: string;
}

export interface SaveMemoryInput {
  reason?: string;
  category?: string;
  content?: string;
  updates?: SaveMemoryUpdate[];
}

export function normalizeSaveMemoryInput(input: SaveMemoryInput | undefined) {
  if (!input) {
    return { reason: "", updates: [] as SaveMemoryUpdate[] };
  }

  if (input.updates?.length) {
    return {
      reason: input.reason?.trim() ?? "",
      updates: input.updates,
    };
  }

  if (input.category && input.content) {
    return {
      reason: input.reason?.trim() ?? "",
      updates: [{ category: input.category, content: input.content }],
    };
  }

  return {
    reason: input.reason?.trim() ?? "",
    updates: [] as SaveMemoryUpdate[],
  };
}

export function isSaveMemoryPending(part: EveDynamicToolPart) {
  return (
    part.state === "approval-requested" &&
    part.toolMetadata?.eve?.inputRequest &&
    !part.toolMetadata?.eve?.inputResponse
  );
}
