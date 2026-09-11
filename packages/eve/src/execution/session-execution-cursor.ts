import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { ContinuationHookTokensKey } from "#context/keys.js";
import {
  SessionStateCursor,
  type SessionStateTransition,
} from "#execution/session-state-cursor.js";
import type { TurnStepInput, TurnStepPayload } from "#execution/turn-step.js";

type SessionHookClaims = Pick<SessionCommandInbox, "claimSessionHook" | "sessionHookTokens">;

/** Mutable durable state owned by the one workflow executing a session. */
export class SessionExecutionCursor extends SessionStateCursor {
  readonly parentWritable: WritableStream<Uint8Array>;

  private readonly commandInbox: SessionHookClaims;
  private readonly claimedSessionHookTokens: Set<string>;

  constructor(input: {
    readonly commandInbox: SessionHookClaims;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  }) {
    super(input);
    this.commandInbox = input.commandInbox;
    this.claimedSessionHookTokens = new Set(input.commandInbox.sessionHookTokens);
    this.parentWritable = input.parentWritable;
  }

  /** Adopts a transition after claiming every continuation address it introduced. */
  async adopt(transition: SessionStateTransition): Promise<void> {
    const serializedContext = transition.serializedContext ?? this.serializedContext;
    const sessionState = transition.sessionState ?? this.sessionState;
    const recorded = serializedContext[ContinuationHookTokensKey.name];
    const candidates = Array.isArray(recorded)
      ? recorded.filter((token): token is string => typeof token === "string" && token.length > 0)
      : [];
    if (sessionState.continuationToken !== "") candidates.push(sessionState.continuationToken);

    for (const token of candidates) {
      if (this.claimedSessionHookTokens.has(token)) continue;
      await this.commandInbox.claimSessionHook(token);
      this.claimedSessionHookTokens.add(token);
    }
    this.adoptState(transition);
  }

  createStepInput(input: TurnStepPayload | undefined, abortSignal?: AbortSignal): TurnStepInput {
    return {
      abortSignal,
      input,
      parentWritable: this.parentWritable,
      serializedContext: this.serializedContext,
      sessionState: this.sessionState,
    };
  }
}
