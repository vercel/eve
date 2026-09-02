import type { Client } from "#client/client.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { EvalSessionDriver, type EvalSessionStartedEvent } from "#evals/session.js";
import type { EveEvalLiveTurn, EveEvalSessionResult } from "#evals/types.js";
import { toErrorMessage } from "#shared/errors.js";

export class EvalSessionManager {
  readonly #client: Client;
  readonly #signal: AbortSignal | undefined;
  readonly #collector: AssertionCollector;
  readonly #onSessionStart: ((event: EvalSessionStartedEvent) => void) | undefined;
  readonly #operationControllers = new Map<Promise<unknown>, AbortController>();
  readonly #ownedSessions = new Map<string, Readonly<Record<string, string>> | undefined>();
  readonly #sessions: EvalSessionDriver[] = [];
  #primary: EvalSessionDriver | undefined;
  #terminationReason: string | undefined;

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

  get primary(): EvalSessionDriver {
    this.#assertActive();
    this.#primary ??= this.#createSession(true);
    return this.#primary;
  }

  newSession(): EvalSessionDriver {
    this.#assertActive();
    return this.#createSession(false);
  }

  async attachSession(
    sessionId: string,
    options?: { readonly startIndex?: number },
  ): Promise<EvalSessionDriver> {
    this.#assertActive();
    const session = this.#createAttachedSession(sessionId, options);
    await session.readTurn(options);
    return session;
  }

  watchTurn(sessionId: string, options?: { readonly startIndex?: number }): EveEvalLiveTurn {
    this.#assertActive();
    return this.#createAttachedSession(sessionId, options).watchTurn(options, sessionId);
  }

  snapshots(): readonly EveEvalSessionResult[] {
    return this.#sessions.map((session) => session.snapshot());
  }

  registerOwnedSessionIds(
    sessionIds: readonly string[],
    headers?: Readonly<Record<string, string>>,
  ): void {
    for (const sessionId of sessionIds) {
      this.#ownedSessions.set(sessionId, headers === undefined ? undefined : { ...headers });
    }
  }

  async runOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertActive();
    const controller = new AbortController();
    const pending = operation(controller.signal);
    this.#operationControllers.set(pending, controller);
    try {
      return await pending;
    } finally {
      this.#operationControllers.delete(pending);
    }
  }

  async terminateOwnedSessions(reason: string, signal?: AbortSignal): Promise<void> {
    this.#terminationReason = reason;
    const abortPendingOperations = () => {
      for (const controller of this.#operationControllers.values()) {
        controller.abort(signal?.reason);
      }
    };
    signal?.addEventListener("abort", abortPendingOperations, { once: true });
    if (signal?.aborted) abortPendingOperations();

    try {
      while (this.#operationControllers.size > 0) {
        await settleWithSignal(Promise.allSettled(this.#operationControllers.keys()), signal);
      }

      const sessions = [...this.#ownedSessions];
      const outcomes = await settleWithSignal(
        Promise.allSettled(
          sessions.map(async ([sessionId, headers]) => {
            try {
              await this.#client.sessions.attach(sessionId).reset({ headers, reason, signal });
            } catch (error) {
              throw new Error(`Session ${JSON.stringify(sessionId)}: ${toErrorMessage(error)}`, {
                cause: error,
              });
            }
          }),
        ),
        signal,
      );
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [toErrorMessage(outcome.reason)] : [],
      );
      if (failures.length > 0) {
        throw new Error(`Failed to terminate eval-created sessions: ${failures.join("; ")}`);
      }
    } finally {
      signal?.removeEventListener("abort", abortPendingOperations);
    }
  }

  lastTurnSession(): EvalSessionDriver | undefined {
    if (this.#primary?.lastTurn !== undefined) {
      return this.#primary;
    }

    return this.#sessions.find((session) => session.lastTurn !== undefined);
  }

  hasActivity(): boolean {
    return this.#sessions.length > 0;
  }

  #createSession(primary: boolean): EvalSessionDriver {
    const session = new EvalSessionDriver({
      client: this.#client,
      collector: this.#collector,
      onSessionCreated: (sessionId, headers) => this.registerOwnedSessionIds([sessionId], headers),
      onSessionStart: this.#onSessionStart,
      primary,
      runOperation: (operation) => this.runOperation(operation),
      signal: this.#signal,
    });
    this.#sessions.push(session);
    return session;
  }

  #createAttachedSession(
    sessionId: string,
    options?: { readonly startIndex?: number },
  ): EvalSessionDriver {
    const session = new EvalSessionDriver({
      client: this.#client,
      collector: this.#collector,
      onSessionStart: this.#onSessionStart,
      primary: false,
      runOperation: (operation) => this.runOperation(operation),
      session: this.#client.sessions.attach(sessionId, {
        streamIndex: options?.startIndex ?? 0,
      }),
      signal: this.#signal,
    });
    this.#sessions.push(session);
    return session;
  }

  #assertActive(): void {
    if (this.#terminationReason !== undefined) {
      throw new Error(this.#terminationReason);
    }
  }
}

async function settleWithSignal<T>(task: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await task;
  signal.throwIfAborted();

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
