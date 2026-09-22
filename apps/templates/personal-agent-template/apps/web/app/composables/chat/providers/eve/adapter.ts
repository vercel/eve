import type { UIMessage } from "ai";
import type { EveMessage } from "eve/vue";

export function toUIMessages(messages: readonly EveMessage[]): UIMessage[] {
  return [...messages] as UIMessage[];
}
