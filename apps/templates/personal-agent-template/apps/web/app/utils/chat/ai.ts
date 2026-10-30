import type { UIMessage } from "ai";
import { isTextUIPart } from "ai";
import { sourceToInlineMdc } from "~/utils/tool";

export function getMergedParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  const result: UIMessage["parts"] = [];
  for (const part of parts) {
    const prev = result[result.length - 1];
    if (part.type === "source-url") {
      if (prev && isTextUIPart(prev)) {
        result[result.length - 1] = {
          type: "text",
          text: prev.text + sourceToInlineMdc(part.url),
        };
      }
      continue;
    }
    if (isTextUIPart(part) && prev && isTextUIPart(prev)) {
      result[result.length - 1] = { type: "text", text: prev.text + part.text };
    } else {
      result.push(part);
    }
  }
  return result;
}
