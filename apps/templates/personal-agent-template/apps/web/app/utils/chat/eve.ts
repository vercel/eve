import { isDynamicToolUIPart, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import type { EveToolUIPart } from "~/composables/chat/providers/eve/adapter";

export function hasVisibleParts(parts: UIMessage["parts"]): boolean {
  return parts.some((part) => {
    if (part.type === "text" || part.type === "file") return true;
    if (part.type === "reasoning") return part.text.trim().length > 0;
    return isToolUIPart(part) || isDynamicToolUIPart(part);
  });
}

export function normalizeEveParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  return parts.filter(
    (part) =>
      part.type !== "step-start" && (part.type !== "reasoning" || part.text.trim().length > 0),
  );
}

export function shouldShowToolInput(part: EveToolUIPart): boolean {
  const request = part.interaction?.request;
  if (!request) {
    return true;
  }
  return request.display === "confirmation";
}

export function getToolDisplayName(part: EveToolUIPart): string {
  if (part.toolName === "ask_question") {
    return part.interaction?.request?.prompt ?? "Question";
  }
  return toolLabel(part) ?? part.toolName;
}

function toolLabel(part: EveToolUIPart): string | undefined {
  return part.label;
}
