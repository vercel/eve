import type { TokenUsage } from "./conversation-view.js";

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

  usage(current: TokenUsage): TokenUsage {
    return {
      inputTokens: Math.max(0, current.inputTokens - this.#baseline.inputTokens),
      outputTokens: Math.max(0, current.outputTokens - this.#baseline.outputTokens),
    };
  }

  settle(current: TokenUsage): ({ elapsedMs: number } & TokenUsage) | undefined {
    const startedAtMs = this.#startedAtMs;
    if (startedAtMs === undefined) return undefined;
    this.#startedAtMs = undefined;
    return { elapsedMs: Date.now() - startedAtMs, ...this.usage(current) };
  }

  reset(): void {
    this.#startedAtMs = undefined;
    this.#baseline = { inputTokens: 0, outputTokens: 0 };
  }
}
