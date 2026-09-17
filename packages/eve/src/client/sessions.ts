import { ClientSession, type ClientSessionContext } from "#client/session.js";
import type { MessageResponse } from "#client/message-response.js";
import type { CreateSessionOptions, SendTurnInput } from "#client/types.js";

/** Result of explicitly creating an ID-addressed client session. */
export interface CreatedClientSession<TOutput = unknown> {
  readonly response: MessageResponse<TOutput>;
  readonly session: ClientSession;
}

/** Result of creating a session before its first turn. */
export interface CreatedIdleClientSession {
  readonly session: ClientSession;
}

/** Collection surface for explicitly creating or attaching ID-addressed sessions. */
export class ClientSessions {
  readonly #context: ClientSessionContext;

  /** @internal */
  constructor(context: ClientSessionContext) {
    this.#context = context;
  }

  /** Creates a session and starts its first turn with a message. */
  async create<TOutput = unknown>(
    input: SendTurnInput<TOutput>,
  ): Promise<CreatedClientSession<TOutput>>;
  /** Creates a conversation session before its first turn. */
  async create(options?: CreateSessionOptions): Promise<CreatedIdleClientSession>;
  async create<TOutput = unknown>(
    input: CreateSessionOptions | SendTurnInput<TOutput> = {},
  ): Promise<CreatedClientSession<TOutput> | CreatedIdleClientSession> {
    if ("message" in input) return await ClientSession.create(this.#context, input);
    return { session: await ClientSession.prewarm(this.#context, input) };
  }

  /** Attaches a fixed handle to a known session ID without performing I/O. */
  attach(sessionId: string, options?: { readonly streamIndex?: number }): ClientSession {
    if (sessionId.length === 0) throw new Error("sessionId must be a non-empty string.");
    return new ClientSession(this.#context, {
      sessionId,
      streamIndex: options?.streamIndex ?? 0,
    });
  }
}
