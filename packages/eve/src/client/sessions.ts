import { ClientSession, type ClientSessionContext } from "#client/session.js";
import type { MessageResponse } from "#client/message-response.js";
import type { SendTurnInput } from "#client/types.js";

/** Result of explicitly creating an ID-addressed client session. */
export interface CreatedClientSession<TOutput = unknown> {
  readonly response: MessageResponse<TOutput>;
  readonly session: ClientSession;
}

/** Collection surface for explicitly creating or attaching ID-addressed sessions. */
export class ClientSessions {
  readonly #context: ClientSessionContext;

  /** @internal */
  constructor(context: ClientSessionContext) {
    this.#context = context;
  }

  /** Creates a session immediately and returns its fixed handle plus first-turn response. */
  async create<TOutput = unknown>(
    input: SendTurnInput<TOutput>,
  ): Promise<CreatedClientSession<TOutput>> {
    const session = new ClientSession(this.#context, { streamIndex: 0 }, "sessions");
    const response = await session.send(input);
    return { response, session };
  }

  /** Attaches a fixed handle to a known session ID without performing I/O. */
  attach(sessionId: string): ClientSession {
    if (sessionId.length === 0) throw new Error("sessionId must be a non-empty string.");
    return new ClientSession(this.#context, { sessionId, streamIndex: 0 }, "sessions");
  }
}
