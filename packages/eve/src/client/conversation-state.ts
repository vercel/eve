import type { EveAuthorizationPart, EveMessageData } from "#client/message-reducer-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

export interface ConversationTurn {
  readonly turnId: string;
  readonly status: "active" | "completed" | "cancelled" | "failed";
}

export interface ConversationInput {
  readonly request: InputRequest;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly status: "open" | "responded" | "settled";
  readonly response?: InputResponse;
  readonly outcome?: string;
}

export type ChildObservation =
  | { readonly status: "not-followed" }
  | { readonly status: "following"; readonly conversation: ConversationState }
  | {
      readonly status: "ended";
      readonly conversation: ConversationState;
      readonly outcome: "completed" | "failed" | "cancelled";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "unsupported-stream" | "stream-error";
      /** Partial detail remains renderable when a stream fails after observation began. */
      readonly conversation?: ConversationState;
    };

export interface ChildCall {
  readonly callId: string;
  readonly name: string;
  readonly childSessionId: string;
  readonly originTurnId: string;
  readonly background: boolean;
  /** Parent completion may precede the last child event; it is not an authoritative child outcome. */
  readonly parentStatus: "dispatched" | "working" | "reported-complete" | "cancelled";
  readonly observation: ChildObservation;
}

/** Renderable conversation state. Root and child input IDs occupy separate scopes. */
export interface ConversationState extends EveMessageData {
  readonly activeTurnId?: string;
  readonly turns: Readonly<Record<string, ConversationTurn>>;
  readonly inputs: Readonly<Record<string, ConversationInput>>;
  readonly children: Readonly<Record<string, ChildCall>>;
}

/** Inputs awaiting an answer, including requests introduced in earlier turns. */
export function openConversationInputs(state: ConversationState): readonly ConversationInput[] {
  return Object.values(state.inputs).filter((input) => input.status === "open");
}

/** Authorization attempts remain visible across turns, including parked callbacks. */
export function conversationAuthorizations(
  state: ConversationState,
): readonly EveAuthorizationPart[] {
  return state.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.filter((part): part is EveAuthorizationPart => part.type === "authorization")
      : [],
  );
}
