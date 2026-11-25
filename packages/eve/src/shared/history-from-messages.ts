import type { ModelMessage } from "ai";
import type { JsonValue } from "#shared/json.js";
import type {
  SessionHistoryMessage,
  SessionHistoryPart,
  SessionHistoryToolPart,
} from "#shared/session-history.js";

type MutableToolPart = {
  -readonly [Key in keyof SessionHistoryToolPart]: SessionHistoryToolPart[Key];
};
type ToolResultOutput = Extract<
  Extract<ModelMessage, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>["output"];

export function historyFromMessages(messages: readonly ModelMessage[]): SessionHistoryMessage[] {
  const history: SessionHistoryMessage[] = [];
  const usedCallIds = new Set<string>();
  let assistant: SessionHistoryPart[] = [];
  let stepCalls = new Map<string, MutableToolPart>();
  const closeAssistant = () => {
    const parts = assistant.filter(
      (part) => part.type === "text" || part.output !== undefined || part.error !== undefined,
    );
    if (parts.length > 0) history.push({ parts, role: "assistant" });
    assistant = [];
  };
  for (const message of messages) {
    if (message.role === "user") {
      closeAssistant();
      const text = textOf(message.content);
      if (text.length > 0) history.push({ role: "user", text });
    } else if (message.role === "assistant") {
      stepCalls = new Map();
      if (typeof message.content === "string") {
        if (message.content.trim().length > 0)
          assistant.push({ text: message.content, type: "text" });
        continue;
      }
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim().length > 0) {
          assistant.push({ text: part.text, type: "text" });
        } else if (part.type === "tool-call") {
          const call: MutableToolPart = {
            input: part.input as JsonValue,
            name: part.toolName,
            type: "tool",
          };
          if (!usedCallIds.has(part.toolCallId)) {
            call.callId = part.toolCallId;
            usedCallIds.add(part.toolCallId);
          }
          stepCalls.set(part.toolCallId, call);
          assistant.push(call);
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const call = stepCalls.get(part.toolCallId);
        if (call !== undefined) Object.assign(call, resultOf(part.output));
      }
    }
  }
  closeAssistant();
  return history;
}

function textOf(content: Extract<ModelMessage, { role: "user" }>["content"]): string {
  if (typeof content === "string") return content.trim();
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

function resultOf(
  output: ToolResultOutput,
): { readonly output: JsonValue } | { readonly error: string } {
  switch (output.type) {
    case "text":
      return { output: output.value };
    case "json":
      return { output: output.value as JsonValue };
    case "error-text":
      return { error: output.value };
    case "error-json":
      return { error: JSON.stringify(output.value) };
    case "execution-denied":
      return {
        error:
          output.reason === undefined
            ? "The call was denied."
            : `The call was denied: ${output.reason}`,
      };
    case "content":
      return {
        output: output.value
          .map((item) =>
            item.type === "text"
              ? item.text
              : `[${"mediaType" in item ? item.mediaType : "file"} result not copied]`,
          )
          .join("\n"),
      };
    default:
      return { error: "The call's result could not be copied." };
  }
}
