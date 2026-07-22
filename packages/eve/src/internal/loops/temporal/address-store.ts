export interface TemporalLoopAddress {
  readonly continuationToken: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly workflowId: string;
}

interface StartingTemporalLoopAddress {
  continuationToken: string;
  readonly sessionId: string;
  readonly workflowId: string;
}

interface ActiveTemporalLoopAddress extends StartingTemporalLoopAddress {
  readonly runId: string;
}

type StoredTemporalLoopAddress =
  | { readonly kind: "starting"; readonly value: StartingTemporalLoopAddress }
  | { readonly kind: "active"; readonly value: ActiveTemporalLoopAddress }
  | { readonly kind: "settled"; readonly value: ActiveTemporalLoopAddress };

/** Process-local continuation-token ownership for the local Temporal loop runtime. */
export class TemporalLoopAddressStore {
  readonly #bySession = new Map<string, StoredTemporalLoopAddress>();
  readonly #sessionByToken = new Map<string, string>();

  begin(input: {
    readonly continuationToken: string;
    readonly sessionId: string;
    readonly workflowId: string;
  }): void {
    requireIdentifier(input.continuationToken, "Continuation token");
    requireIdentifier(input.sessionId, "Session id");
    requireIdentifier(input.workflowId, "Workflow id");
    if (this.#bySession.has(input.sessionId)) {
      throw new Error(`Session "${input.sessionId}" already exists.`);
    }
    this.#claimToken(input.continuationToken, input.sessionId);
    this.#bySession.set(input.sessionId, {
      kind: "starting",
      value: { ...input },
    });
  }

  attachRun(input: { readonly runId: string; readonly sessionId: string }): void {
    requireIdentifier(input.runId, "Run id");
    const stored = this.#requireSession(input.sessionId);
    if (stored.kind === "settled") {
      throw new Error(`Session "${input.sessionId}" is already settled.`);
    }
    if (stored.kind === "active") {
      if (stored.value.runId !== input.runId) {
        throw new Error(`Session "${input.sessionId}" is already attached to another run.`);
      }
      return;
    }
    this.#bySession.set(input.sessionId, {
      kind: "active",
      value: { ...stored.value, runId: input.runId },
    });
  }

  rekey(input: { readonly continuationToken: string; readonly sessionId: string }): void {
    requireIdentifier(input.continuationToken, "Continuation token");
    const stored = this.#requireSession(input.sessionId);
    if (stored.kind === "settled") {
      throw new Error(`Session "${input.sessionId}" is already settled.`);
    }
    if (stored.value.continuationToken === input.continuationToken) return;

    this.#claimToken(input.continuationToken, input.sessionId);
    this.#sessionByToken.delete(stored.value.continuationToken);
    stored.value.continuationToken = input.continuationToken;
  }

  resolve(continuationToken: string): TemporalLoopAddress | null {
    const sessionId = this.#sessionByToken.get(continuationToken);
    if (sessionId === undefined) return null;
    const stored = this.#bySession.get(sessionId);
    if (stored?.kind !== "active") return null;
    return { ...stored.value };
  }

  settle(sessionId: string): boolean {
    const stored = this.#bySession.get(sessionId);
    if (stored === undefined || stored.kind === "settled") return false;
    if (stored.kind === "starting") {
      this.#sessionByToken.delete(stored.value.continuationToken);
      this.#bySession.delete(sessionId);
      return true;
    }
    this.#sessionByToken.delete(stored.value.continuationToken);
    this.#bySession.set(sessionId, { kind: "settled", value: stored.value });
    return true;
  }

  #claimToken(continuationToken: string, sessionId: string): void {
    const owner = this.#sessionByToken.get(continuationToken);
    if (owner !== undefined && owner !== sessionId) {
      throw new Error(
        `Continuation token "${continuationToken}" is already owned by session "${owner}".`,
      );
    }
    this.#sessionByToken.set(continuationToken, sessionId);
  }

  #requireSession(sessionId: string): StoredTemporalLoopAddress {
    const stored = this.#bySession.get(sessionId);
    if (stored === undefined) throw new Error(`Unknown session "${sessionId}".`);
    return stored;
  }
}

function requireIdentifier(value: string, name: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string.`);
}
