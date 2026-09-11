import type { ComputedRef, Ref } from "vue";
import type { EveMessageData, UseEveAgentOptions } from "eve/vue";
import type { EveSessionCursor } from "#shared/types/thread";
import type { UIMessage } from "ai";
import type { AgentInputResponse } from "~/components/AgentInputRequest.vue";

export type EveStreamEvent = NonNullable<
  UseEveAgentOptions<EveMessageData>["initialEvents"]
>[number];

export type ChatStatus = "ready" | "submitted" | "streaming" | "error";

export interface ChatSessionOptions {
  initialSession?: EveSessionCursor;
  initialEvents?: readonly EveStreamEvent[];
}

export interface ChatSession {
  messages: ComputedRef<UIMessage[]>;
  status: Ref<ChatStatus> | ComputedRef<ChatStatus>;
  error: Ref<Error | undefined> | ComputedRef<Error | undefined>;
  isBusy: ComputedRef<boolean>;
  sendMessage: (text: string) => Promise<void>;
  sendInputResponses: (responses: AgentInputResponse[]) => Promise<void>;
  stop: () => void;
  reset: () => void;
  retry: () => Promise<void>;
}
