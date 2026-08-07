/**
 * Id generator shared by `registerOTel` and the agent OTel provider. A span
 * whose lifetime crosses durable worker boundaries (`agent.turn`) is emitted
 * at its terminal; priming the next span id lets that span carry the
 * pre-allocated id its descendants already parented to.
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
