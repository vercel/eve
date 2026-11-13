import type { ChatStatus } from "ai";
import type {
  ClientSession,
  ConversationState,
  MessageContent,
  RespondTurnOptions,
  SendTurnOptions,
  SessionStreamEvent,
} from "eve/client";
import type { Answer } from "eve/events";

/** The AI SDK chat lifecycle, plus the initial catch-up read of a saved session. */
export type ChatAgentStatus = ChatStatus | "resuming";

export interface ChatAgent extends Pick<
  ConversationState,
  "messages" | "view"
> {
  readonly childOpenings: readonly Extract<
    SessionStreamEvent,
    { type: "child.opened" }
  >[];
  readonly cancel: () => ReturnType<ClientSession["cancel"]>;
  readonly error?: Error;
  readonly events: readonly SessionStreamEvent[];
  readonly hasOlder: boolean;
  readonly isLoadingOlder: boolean;
  readonly loadOlder: () => Promise<void>;
  readonly respond: <TOutput = unknown>(
    answers: readonly Answer[],
    options?: RespondTurnOptions<TOutput>
  ) => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly send: <TOutput = unknown>(
    message: MessageContent,
    options?: SendTurnOptions<TOutput>
  ) => Promise<void>;
  readonly status: ChatAgentStatus;
}
