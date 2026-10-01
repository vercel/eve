import type { ClientSession } from "#client/session.js";
import type { CreateSessionOptions, SendTurnInput } from "#client/types.js";
import type { Client } from "#client/client.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { EvalSessionDriver, type EvalSessionStartedEvent } from "#evals/session.js";
import { cleanupEvalSessions } from "#evals/session-cleanup.js";
import type { EveEvalLiveTurn, EveEvalSessionResult, EveEvalTarget } from "#evals/types.js";

export class EvalSessionManager {
  readonly #client: Client;
  readonly #signal: AbortSignal | undefined;
  readonly #targetKind: EveEvalTarget["kind"] | undefined;
  readonly #collector: AssertionCollector;
  readonly #onSessionStart: ((event: EvalSessionStartedEvent) => void) | undefined;
  readonly #sessions: EvalSessionDriver[] = [];
  #lastTurnSession: EvalSessionDriver | undefined;

  constructor(input: {
    readonly client: Client;
    readonly collector?: AssertionCollector;
    readonly onSessionStart?: (event: EvalSessionStartedEvent) => void;
    readonly signal?: AbortSignal;
    readonly targetKind?: EveEvalTarget["kind"];
  }) {
    this.#client = input.client;
    this.#targetKind = input.targetKind;
    this.#collector = input.collector ?? new AssertionCollector();
    this.#onSessionStart = input.onSessionStart;
    this.#signal = input.signal;
  }

  async session(options: CreateSessionOptions = {}): Promise<EvalSessionDriver> {
    this.#assertStubsSupported(options.stubs);
    const { session } = await this.#client.sessions.create({
      ...options,
      signal: options.signal ?? this.#signal,
    });
    return this.#register(session);
  }

  async send(message: SendTurnInput["message"], options: Omit<SendTurnInput, "message"> = {}) {
    this.#assertStubsSupported(options.stubs);
    const { session, response } = await this.#client.sessions.create({
      turnPolicy: "queue",
      ...options,
      message,
      signal: options.signal ?? this.#signal,
    });
    const driver = this.#register(session);
    return await driver.consume(response, message).result();
  }

  async attachSession(
    sessionId: string,
    options?: { readonly startIndex?: number },
  ): Promise<EvalSessionDriver> {
    const session = this.#createAttachedSession(sessionId, options);
    await session.readTurn(options);
    return session;
  }

  watchTurn(sessionId: string, options?: { readonly startIndex?: number }): EveEvalLiveTurn {
    return this.#createAttachedSession(sessionId, options).watchTurn(options);
  }

  snapshots(): readonly EveEvalSessionResult[] {
    return this.#sessions.map((session) => session.snapshot());
  }

  lastTurnSession(): EvalSessionDriver | undefined {
    return this.#lastTurnSession;
  }

  hasActivity(): boolean {
    return this.#sessions.length > 0;
  }
  /** @internal */
  async cleanup(signal: AbortSignal): Promise<readonly PromiseSettledResult<void>[]> {
    return await cleanupEvalSessions(this.#sessions, signal);
  }

  /**
   * A deployed server running an eve without tool stubs ignores the field and
   * runs real tools, so remote targets are refused here, before any request.
   */
  #assertStubsSupported(stubs: string | undefined): void {
    if (stubs === undefined || this.#targetKind !== "remote") return;
    throw new Error(
      `Tool stub set "${stubs}" needs the local server that \`eve eval\` starts. ` +
        "This eval runs against an `eve eval --url` target, which runs every tool for real. " +
        "Run `eve eval` without --url to use tool stubs.",
    );
  }

  #register(session: ClientSession): EvalSessionDriver {
    const driver = new EvalSessionDriver({
      collector: this.#collector,
      onSessionStart: this.#onSessionStart,
      onTurn: (completed) => {
        this.#lastTurnSession = completed;
      },
      primary: this.#sessions.length === 0,
      session,
      signal: this.#signal,
    });
    this.#sessions.push(driver);
    return driver;
  }

  #createAttachedSession(
    sessionId: string,
    options?: { readonly startIndex?: number },
  ): EvalSessionDriver {
    return this.#register(
      this.#client.sessions.attach(sessionId, { streamIndex: options?.startIndex ?? 0 }),
    );
  }
}
