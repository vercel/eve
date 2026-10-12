import type { ConversationInteraction } from "#client/conversation-state.js";
import type { CallOutcome, CapabilityKind } from "#protocol/session-events/families/call.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";

/**
 * One message of a conversation: what a person sent, or what the agent's turn produced.
 *
 * `metadata.status` is the message's own state: a person's message is `"submitted"` while this
 * client waits for eve to consume it, `"failed"` if sending failed, and `"complete"` once its turn
 * consumed it; the agent's message is `"streaming"` while its turn runs and `"complete"` after.
 * `optimistic` marks a message this client shows before eve consumed it. `turnId` names the turn,
 * and `result` holds the turn's structured result once it completed.
 */
export interface EveMessage {
  readonly id: string;
  readonly metadata?: EveMessageMetadata;
  readonly parts: readonly EveMessagePart[];
  readonly role: "assistant" | "user";
}

export interface EveMessageMetadata {
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
export type EveInteractionPart = ConversationInteraction & { readonly type: "interaction" };

/**
 * A call the turn made, as its row in the session's tables stands: the same `status` and
 * `outcome` every eve reader reads.
 *
 * - `status` is `"streaming"` while the model still writes the input (`inputText` holds it so
 *   far), then `"requested"`, `"running"`, and `"settled"`.
 * - `outcome`, once settled: `"completed"` (with `output`), `"failed"` (with `error`),
 *   `"rejected"` (a person or a policy refused it), or `"interrupted"` (its turn or task was cut
 *   short before it finished). A newer eve can add outcomes; keep a default branch.
 * - `output` is the result once completed, and the latest preliminary output while running.
 * - `interaction` is the latest approval or question about the call, such as one a subagent the
 *   call runs relayed; while it is open, the call waits on a person.
 * - `label` is how the call reads to people, as eve's channels and terminal UI show it: the
 *   tool's label for its latest output or its completion, its label, or a readable form of its
 *   name.
 */
export interface EveToolPart {
  readonly type: "tool";
  readonly callId: string;
  readonly stepIndex?: number;
  /**
   * What the call invokes: a tool, an agent, a skill, or `control`, the model waiting on or
   * cancelling its own tasks, which most activity displays leave out.
   */
  readonly kind?: CapabilityKind;
  readonly name: string;
  readonly label: string;
  readonly status: "streaming" | "requested" | "running" | "settled";
  readonly outcome?: CallOutcome;
  readonly input?: unknown;
  readonly inputText?: string;
  readonly output?: unknown;
  readonly error?: ErrorInfo;
  /** Why it ended as it did, such as `turn-cancelled`. */
  readonly reason?: string;
  /** The task that serves the call. */
  readonly taskId?: string;
  readonly interaction?: ConversationInteraction;
}
