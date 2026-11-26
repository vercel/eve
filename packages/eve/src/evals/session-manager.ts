import { createLogger } from "#internal/logging.js";
import { createClientError } from "#client/client-error.js";
import { getDeliveryReceipt } from "#client/delivery.js";
import type { ClientSession } from "#client/session.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { SendTurnInput, SendTurnOptions } from "#client/types.js";
import type { Client } from "#client/client.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { EvalSessionDriver, type EvalSessionStartedEvent } from "#evals/session.js";
import { cleanupEvalSessions } from "#evals/session-cleanup.js";
import type { EveEvalSessionOptions, EveEvalSessionResult } from "#evals/types.js";
import { createEveSessionStubsRoutePath, EVE_DEV_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { isObject, readNonEmptyString } from "#shared/guards.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

const log = createLogger("eve.evals");

export class EvalSessionManager {
  readonly #client: Client;
  readonly #devRoutes: boolean;
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
    readonly devRoutes?: boolean;
    readonly onSessionStart?: (event: EvalSessionStartedEvent) => void;
    readonly signal?: AbortSignal;
  }) {
    this.#client = input.client;
    this.#devRoutes = input.devRoutes ?? false;
    this.#collector = input.collector ?? new AssertionCollector();
    this.#onSessionStart = input.onSessionStart;
    this.#signal = input.signal;
  }

  async session(options: EveEvalSessionOptions = {}): Promise<EvalSessionDriver> {
    const startedAt = Date.now();
    const signal = options.signal ?? this.#signal;
    const session =
      options.history === undefined
        ? (await this.#client.sessions.create({ ...options, signal })).session
        : await this.#createDevSession({ ...options, history: options.history, signal });
    const created = { startedAt, notReadyMs: 0, acceptedAt: Date.now() };
    if (options.stubs !== undefined)
      this.#stubbedSessions.push({
        sessionId: session.state.sessionId,
        headers: options.headers,
        ruleIds: options.stubs.map((rule) => rule.id),
      });
    const driver = this.#register(session);
    driver.recordSend("prewarm", created);
    return driver;
  }

  async #createDevSession(
    options: EveEvalSessionOptions & { readonly history: readonly SessionHistoryMessage[] },
  ): Promise<ClientSession> {
    if (!this.#devRoutes) {
      throw new Error(
        "t.session({ history }) requires a target with dev routes enabled (such as local `eve eval`). Production deployments do not expose fixed-history session creation.",
      );
    }
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    const body: Record<string, unknown> = { history: options.history };
    if (options.stubs !== undefined) body.stubs = options.stubs;
    const response = await this.#client.fetch(EVE_DEV_SESSION_ROUTE_PATH, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
      signal: options.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw createClientError(response.status, text, response.headers);
    }
    const payload: unknown = await response.json();
    const sessionId = isObject(payload) ? readNonEmptyString(payload.sessionId) : undefined;
    if (sessionId === undefined) {
      throw new Error("Dev session creation returned an unexpected response without a sessionId.");
    }
    return this.#client.sessions.attach(sessionId);
  }

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
    const { session, delivery } = await this.#client.sessions.create({
      turnPolicy: "queue",
      ...options,
      message,
      signal: options.signal ?? this.#signal,
    });
    const driver = this.#register(session);
    driver.recordSend("create", getDeliveryReceipt(delivery));
    return await driver
      .consume(delivery.stream({ signal: options.signal ?? this.#signal }), message, {
        deliveryId: delivery.deliveryId,
      })
      .result();
  }

  attach(sessionId: string, options?: { readonly startIndex?: number }): EvalSessionDriver {
    return this.#createAttachedSession(sessionId, options);
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
    const history = this.#sessions
      .filter((driver) => driver.id === sessionId)
      .flatMap((driver) => driver.events)
      .filter((event) => event.meta.position.line < startIndex);
    return this.#register(
      this.#client.sessions.attach(sessionId, { streamIndex: startIndex }),
      history,
    );
  }
}
