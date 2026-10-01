import type { TokenUsage } from "./conversation-view.js";

/**
 * One turn's wall clock and token flow, measured against the session's summed
 * step usage when work started. Armed when work starts and consumed once by
 * the end-of-turn coda, so answering an approval or question mid-turn does
 * not split the turn.
 */
export class TurnClock {
  #startedAtMs?: number;
  #baseline: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  arm(usage: TokenUsage): void {
    this.#startedAtMs = Date.now();
    this.#baseline = usage;
  }

  get armed(): boolean {
    return this.#startedAtMs !== undefined;
  }

  get startedAtMs(): number | undefined {
    return this.#startedAtMs;
  }

  /** Token flow since the clock was armed. */
  usage(current: TokenUsage): TokenUsage {
    return {
      inputTokens: Math.max(0, current.inputTokens - this.#baseline.inputTokens),
      outputTokens: Math.max(0, current.outputTokens - this.#baseline.outputTokens),
    };
  }

  /** Consumes the armed clock, or returns `undefined` when no turn was armed. */
  settle(current: TokenUsage): ({ elapsedMs: number } & TokenUsage) | undefined {
    const startedAtMs = this.#startedAtMs;
    if (startedAtMs === undefined) return undefined;
    this.#startedAtMs = undefined;
    return { elapsedMs: Date.now() - startedAtMs, ...this.usage(current) };
  }

  /** Drops the clock without a coda (conversation boundaries). */
  reset(): void {
    this.#startedAtMs = undefined;
    this.#baseline = { inputTokens: 0, outputTokens: 0 };
  }
}
