import type { SubagentSession } from "./subagent-session.ts";
import { defaultMessageReducer, type EveAgentReducer, type EveMessageData } from "eve/client";

export type ChatMessageData = EveMessageData & {
  subagents: Readonly<Record<string, SubagentSession>>;
};
export function chatMessageReducer(): EveAgentReducer<ChatMessageData> {
  const base = defaultMessageReducer();
  return {
    initial: () => ({ ...base.initial(), subagents: {} }),
    reduce(data, event) {
      if (event.type === "subagent.called")
        return {
          ...base.reduce(data, event),
          subagents: { ...data.subagents, [event.data.callId]: event.data },
        };
      if (event.type !== "message.received" || event.data.kind === "execution.background_task")
        return { ...data, ...base.reduce(data, event) };

      // Steering can deliver several messages within one turn. Event IDs identify
      // individual submissions; turn IDs identify the shared agent execution.
      const projected = base.reduce(base.initial(), event).messages[0];
      const message = projected;
      const existingIndex = data.messages.findIndex((item) => item.id === message.id);
      if (existingIndex !== -1) {
        return {
          ...data,
          messages: data.messages.map((item, index) => (index === existingIndex ? message : item)),
        };
      }
      const assistantIndex = data.messages.findIndex(
        (item) => item.role === "assistant" && item.metadata?.turnId === event.data.turnId,
      );
      const index = assistantIndex === -1 ? data.messages.length : assistantIndex;
      return {
        ...data,
        messages: [...data.messages.slice(0, index), message, ...data.messages.slice(index)],
      };
    },
  };
}
