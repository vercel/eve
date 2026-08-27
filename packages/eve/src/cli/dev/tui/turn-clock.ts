/**
 * One turn's wall clock and summed token flow. "When did this turn start"
 * is a single fact; this object is its single representation — armed once
 * per turn (a prompt submit, or an `--input` turn arming itself), fed by
 * step usage reports, and consumed exactly once by the end-of-turn coda.
 * Multi-pass turns (question answers, connection authorizations) re-stream
 * without re-arming, so one turn gets one coda.
 */
export class TurnClock {
  #startedAtMs?: number;
  #usage = { inputTokens: 0, outputTokens: 0 };

  /** Starts the turn: resets the summed flow and stamps the clock. */
  arm(): void {
    this.#startedAtMs = Date.now();
    this.#usage = { inputTokens: 0, outputTokens: 0 };
  }

  get armed(): boolean {
    return this.#startedAtMs !== undefined;
  }

  get startedAtMs(): number | undefined {
    return this.#startedAtMs;
  }

  get usage(): { readonly inputTokens: number; readonly outputTokens: number } {
    return this.#usage;
  }

  addUsage(usage: { inputTokens?: number; outputTokens?: number }): void {
    this.#usage.inputTokens += usage.inputTokens ?? 0;
    this.#usage.outputTokens += usage.outputTokens ?? 0;
  }

  /**
   * Consumes the armed clock, returning the turn's elapsed time and summed
   * flow — or `undefined` when no turn was armed (the coda's "already
   * settled" signal). The flow survives the settle so a repaint between the
   * coda and the next arm still reads the last turn's numbers.
   */
  settle(): { elapsedMs: number; inputTokens: number; outputTokens: number } | undefined {
    const startedAtMs = this.#startedAtMs;
    if (startedAtMs === undefined) return undefined;
    this.#startedAtMs = undefined;
    return { elapsedMs: Date.now() - startedAtMs, ...this.#usage };
  }

  /** Drops the clock without a coda (conversation boundaries). */
  reset(): void {
    this.#startedAtMs = undefined;
    this.#usage = { inputTokens: 0, outputTokens: 0 };
  }
}
