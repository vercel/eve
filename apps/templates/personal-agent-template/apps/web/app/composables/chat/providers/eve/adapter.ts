import type { DynamicToolUIPart, UIMessage } from "ai";
import type { EveMessage, EveMessagePart, EveToolPart } from "eve/vue";

/** Nuxt UI renders AI SDK parts; eve's native call and interaction state stays attached. */
export type EveToolUIPart = DynamicToolUIPart & {
  readonly interaction?: EveToolPart["interaction"];
  readonly callState?: EveToolPart["state"];
  readonly label?: string;
};

function toolPart(part: EveToolPart): EveToolUIPart {
  const base = {
    type: "dynamic-tool" as const,
    toolCallId: part.callId,
    toolName: part.name,
    input: part.input,
    interaction: part.interaction,
    callState: part.state,
    label: part.label,
  };
  if (part.state === "completed")
    return { ...base, state: "output-available", output: part.output };
  if (["completed", "failed", "rejected", "cancelled"].includes(part.state))
    return {
      ...base,
      state: "output-error",
      errorText: part.error?.message ?? "The call stopped.",
    };
  return { ...base, state: part.state === "streaming" ? "input-streaming" : "input-available" };
}

function uiPart(part: EveMessagePart): UIMessage["parts"][number] | undefined {
  switch (part.type) {
    case "tool":
      return toolPart(part);
    case "interaction":
      return toolPart({
        type: "tool",
        callId: part.interactionId,
        name: "ask_question",
        label: part.request.prompt,
        state: part.status === "settled" ? "completed" : "blocked",
        kind: "tool",
        stepIndex: part.stepIndex,
        interaction: part,
      });
    case "text":
    case "reasoning":
      return part;
    case "file":
      return part.url === undefined
        ? undefined
        : { type: "file", mediaType: part.mediaType, url: part.url, filename: part.filename };
  }
}

export function toUIMessages(messages: readonly EveMessage[]): UIMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: message.parts.flatMap((part) => {
      const rendered = uiPart(part);
      return rendered === undefined ? [] : [rendered];
    }),
  }));
}
