/**
 * Trace/span id source shared by the local OTel registration and the agent
 * OTel provider.
 *
 * A turn outlives the worker that starts it, so no live span object can cover
 * it. The provider allocates the turn's span id up front, parents descendants
 * through the persisted span context, and emits the span itself at the turn's
 * terminal — priming this generator so the emitted span carries the id its
 * descendants already reference.
 */
export class AgentSpanIdGenerator {
  #primedSpanId: string | undefined;

  /** Reserves a span id for a span emitted later via {@link withSpanId}. */
  allocateSpanId(): string {
    return randomHexId(16);
  }

  generateSpanId(): string {
    const primed = this.#primedSpanId;
    if (primed !== undefined) {
      this.#primedSpanId = undefined;
      return primed;
    }
    return randomHexId(16);
  }

  generateTraceId(): string {
    return randomHexId(32);
  }

  /** Runs `startSpan` so the next span started carries `spanId`. */
  withSpanId<T>(spanId: string, startSpan: () => T): T {
    this.#primedSpanId = spanId;
    try {
      return startSpan();
    } finally {
      this.#primedSpanId = undefined;
    }
  }
}

const HEX_DIGITS = "0123456789abcdef";

function randomHexId(length: number): string {
  let id: string;
  do {
    id = "";
    for (let index = 0; index < length; index += 1) {
      id += HEX_DIGITS[Math.trunc(Math.random() * 16)];
    }
  } while (!/[1-9a-f]/u.test(id));
  return id;
}
