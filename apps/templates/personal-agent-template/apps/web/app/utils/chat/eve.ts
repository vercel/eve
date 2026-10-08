import { isDynamicToolUIPart, isTextUIPart, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import type { EveDynamicToolPart } from "eve/vue";

export function hasVisibleParts(parts: UIMessage["parts"]): boolean {
  return parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") return true;
    return isToolUIPart(part) || isDynamicToolUIPart(part);
  });
}

export function normalizeEveParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  return parts.filter((part) => part.type !== "step-start");
}

export function shouldShowToolInput(part: EveDynamicToolPart): boolean {
  const request = part.toolMetadata?.eve?.inputRequest;
  if (!request) {
    return true;
  }
  return request.display === "confirmation";
}

export function getToolDisplayName(part: EveDynamicToolPart): string {
  if (part.toolName === "ask_question") {
    return part.toolMetadata?.eve?.inputRequest?.prompt ?? "Question";
  }
  return toolLabel(part) ?? part.toolName;
}

/** eve versions that set `toolMetadata.eve.label` say how a call reads; older ones fall back to its name. */
function toolLabel(part: EveDynamicToolPart): string | undefined {
  const eve: Readonly<Record<string, unknown>> | undefined = part.toolMetadata?.eve;
  return typeof eve?.label === "string" ? eve.label : undefined;
}
