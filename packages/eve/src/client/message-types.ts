import type { CallState } from "#protocol/session-projection/selectors.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import type { CapabilityKind } from "#protocol/session-events/families/call.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";

/**
 * One message of a conversation: what a person sent, or what the agent's turn produced.
 *
 * `metadata.status` is the message's own state: a person's message is `"submitted"` while this
 * client waits for eve to consume it, `"failed"` if sending failed, and `"complete"` once its turn
 * consumed it; the agent's message is `"streaming"` while its turn runs and `"complete"` after.
 * `optimistic` marks a message this client shows before eve consumed it. `turnId` names the turn,
 * and `result` holds the turn's structured result once it completed, on the turn's last message.
 *
 * A turn can show as several agent messages: a message a person sent while it worked splits it,
 * so what the agent did before shows above the person's message and the rest below. Group by
 * `metadata.turnId` to read a turn as one.
 */
export interface EveMessage {
  readonly id: string;
  readonly metadata?: EveMessageMetadata;
  readonly parts: readonly EveMessagePart[];
  readonly role: "assistant" | "user";
}

export interface EveMessageMetadata {
  /** App-owned identifier on a message imported through session history. */
  readonly historyId?: string;
  readonly imported?: true;
  readonly optimistic?: true;
  readonly result?: unknown;
  readonly status?: "complete" | "failed" | "streaming" | "submitted";
  readonly turnId?: string;
}

/**
 * One renderable part of an {@link EveMessage}, discriminated by `type`.
 *
 * `text` and `reasoning` carry the model's text, `"streaming"` until the part completes; `file`
 * is an attachment a person sent; `tool` ({@link EveToolPart}) is a call the turn made; and
 * `interaction` ({@link EveInteractionPart}) is something the turn asked a person that no call
 * carries. `stepIndex` is the turn's step that produced the part. Assistant text and reasoning
 * keep the `id` of their content part as they stream and complete.
 */
export type EveMessagePart =
  | {
      readonly id?: string;
      readonly state?: "done" | "streaming";
      readonly stepIndex?: number;
      readonly text: string;
      readonly type: "text";
    }
  | {
      readonly id?: string;
      readonly state?: "done" | "streaming";
      readonly stepIndex?: number;
      readonly text: string;
      readonly type: "reasoning";
    }
  | {
      readonly filename?: string;
      readonly mediaType: string;
      readonly size?: number;
      readonly stepIndex?: number;
      readonly type: "file";
      readonly url?: string;
    }
  | EveInteractionPart
  | EveToolPart;

/**
 * An interaction no call carries, where its turn asked it: a sign-in, the budget prompt, or a
 * question about no call of this session's. `request` is what it asks (a sign-in's challenge is
 * `request.signIn`), and `status`, `outcome`, and `answer` how it stands. An approval or a
 * question about one of the session's calls shows on that call's {@link EveToolPart} instead.
 */
export type EveInteractionPart = Interaction & { readonly type: "interaction" };

/** A renderable call: partial input while streaming, then the shared call state. */
export type EveToolPart = {
  readonly type: "tool";
  readonly callId: string;
  readonly stepIndex: number;
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly label: string;
  readonly interaction?: Interaction;
} & (
  | {
      readonly state: "streaming";
      readonly inputText: string;
      readonly input?: never;
      readonly output?: never;
      readonly error?: never;
    }
  | {
      readonly state: CallState;
      readonly inputText?: never;
      readonly input?: unknown;
      readonly output?: unknown;
      readonly error?: ErrorInfo;
    }
);
