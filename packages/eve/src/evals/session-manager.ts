import { createLogger } from "#internal/logging.js";
import type { ClientSession } from "#client/session.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { CreateSessionOptions, SendTurnInput, SendTurnOptions } from "#client/types.js";
import type { Client } from "#client/client.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { EvalSessionDriver, type EvalSessionStartedEvent } from "#evals/session.js";
import { cleanupEvalSessions } from "#evals/session-cleanup.js";
import type { EveEvalLiveTurn, EveEvalSessionResult, EveEvalWatchOptions } from "#evals/types.js";
import { createEveSessionStubsRoutePath } from "#protocol/routes.js";

const log = createLogger("eve.evals");

export class EvalSessionManager {
  readonly #client: Client;
  readonly #signal: AbortSignal | undefined;
  readonly #collector: AssertionCollector;
  readonly #onSessionStart: ((event: EvalSessionStartedEvent) => void) | undefined;
  readonly #sessions: EvalSessionDriver[] = [];
  readonly #stubbedSessions: {
    readonly sessionId: string;
    readonly ruleIds: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
  }[] = [];
  #lastTurnSession: EvalSessionDriver | undefined;

  constructor(input: {
    readonly client: Client;
    readonly collector?: AssertionCollector;
    readonly onSessionStart?: (event: EvalSessionStartedEvent) => void;
    readonly signal?: AbortSignal;
  }) {
    this.#client = input.client;
    this.#collector = input.collector ?? new AssertionCollector();
    this.#onSessionStart = input.onSessionStart;
    this.#signal = input.signal;
  }

  async session(options: CreateSessionOptions = {}): Promise<EvalSessionDriver> {
    const { session } = await this.#client.sessions.create({
      ...options,
      signal: options.signal ?? this.#signal,
    });
    if (options.stubs !== undefined)
      this.#stubbedSessions.push({
        sessionId: session.state.sessionId,
        headers: options.headers,
        ruleIds: options.stubs.map((rule) => rule.id),
      });
    return this.#register(session);
  }

  /** A recorded stub failure always fails the eval, even if the agent recovers. */
  async verifyStubs(): Promise<void> {
    for (const session of this.#stubbedSessions) {
      const response = await this.#client.fetch(createEveSessionStubsRoutePath(session.sessionId), {
        headers: session.headers,
        signal: this.#signal,
      });
      if (!response.ok)
        throw new Error(
          `Could not verify tool stubs for session ${session.sessionId} (HTTP ${response.status}).`,
        );
      const result: unknown = await response.json();
      if (typeof result !== "object" || result === null || !("error" in result))
        throw new Error("Invalid tool stub verification response.");
      if (result.error !== null) throw new Error(`Tool stubbing failed: ${String(result.error)}`);
      if (
        !("matchedRuleIds" in result) ||
        !Array.isArray(result.matchedRuleIds) ||
        !result.matchedRuleIds.every((id) => typeof id === "string")
      )
        throw new Error("Invalid tool stub verification response.");
      const matchedRuleIds = result.matchedRuleIds;
      const unused = session.ruleIds.filter((id) => !matchedRuleIds.includes(id));
      if (unused.length > 0) {
        log.warn(`Tool stubs did not match any calls: ${unused.join(", ")}.`, {
          sessionId: session.sessionId,
        });
      }
    }
  }

  async send(message: SendTurnInput["message"], options: SendTurnOptions = {}) {
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

  watchTurn(sessionId: string, options?: EveEvalWatchOptions): EveEvalLiveTurn {
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

  #register(session: ClientSession, history?: readonly SessionStreamEvent[]): EvalSessionDriver {
    const driver = new EvalSessionDriver({
      collector: this.#collector,
      history,
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
    const startIndex = options?.startIndex ?? 0;
    // What this eval already read of the session names the calls a later read settles.
    const history = this.#sessions
      .filter((driver) => driver.sessionId === sessionId)
      .flatMap((driver) => driver.events)
      .filter((event) => event.meta.position.line < startIndex);
    return this.#register(
      this.#client.sessions.attach(sessionId, { streamIndex: startIndex }),
      history,
    );
  }
}
