import { describe, expect, it } from "vitest";

import {
  formatCompactTokenCount,
  formatTokenFlow,
  nextKey,
  parseKey,
  stripPromptControlCharacters,
  takeUntil,
} from "./stream-format.js";

const FLOW_GLYPHS = { arrowUp: "↑", arrowDown: "↓" };

describe("formatCompactTokenCount", () => {
  it("keeps small counts plain and abbreviates with one trimmed decimal", () => {
    expect(formatCompactTokenCount(0)).toBe("0");
    expect(formatCompactTokenCount(999)).toBe("999");
    expect(formatCompactTokenCount(4_000)).toBe("4K");
    expect(formatCompactTokenCount(4_300)).toBe("4.3K");
    expect(formatCompactTokenCount(394_400)).toBe("394.4K");
    expect(formatCompactTokenCount(1_200_000)).toBe("1.2M");
  });
});

describe("formatTokenFlow", () => {
  it("renders the up/down flow", () => {
    expect(formatTokenFlow({ inputTokens: 394_400, outputTokens: 4_300 }, FLOW_GLYPHS)).toBe(
      "↑ 394.4K ↓ 4.3K",
    );
  });

  it("appends the context-fill percentage only when the context size is known", () => {
    expect(
      formatTokenFlow(
        { inputTokens: 24_000, outputTokens: 300, contextSize: 200_000 },
        FLOW_GLYPHS,
      ),
    ).toBe("↑ 24K ↓ 300 12%");
    expect(formatTokenFlow({ inputTokens: 0, outputTokens: 0 }, FLOW_GLYPHS)).toBe("↑ 0 ↓ 0");
  });
});

describe("nextKey", () => {
  it("decodes a complete CSI arrow sequence", () => {
    expect(nextKey("\x1b[A")).toEqual({ key: { type: "up" }, consumed: 3 });
  });

  it("waits for a CSI sequence that is still arriving", () => {
    expect(nextKey("\x1b")).toEqual({ consumed: 0, incomplete: true });
    expect(nextKey("\x1b[")).toEqual({ consumed: 0, incomplete: true });
    expect(nextKey("\x1b[A")).toEqual({ key: { type: "up" }, consumed: 3 });
  });

  it("decodes SS3 application-cursor arrows and waits for the final byte", () => {
    expect(nextKey("\x1bOB")).toEqual({ key: { type: "down" }, consumed: 3 });
    expect(nextKey("\x1bO")).toEqual({ consumed: 0, incomplete: true });
  });

  it("takes a printable run as a single character token", () => {
    expect(nextKey("hello")).toEqual({ key: { type: "character", value: "hello" }, consumed: 5 });
  });

  it("stops a printable run at a control byte", () => {
    expect(nextKey("ab\rcd")).toEqual({ key: { type: "character", value: "ab" }, consumed: 2 });
  });

  it("decodes a lone control byte", () => {
    expect(nextKey("\r")).toEqual({ key: { type: "enter" }, consumed: 1 });
    expect(nextKey("\u007f")).toEqual({ key: { type: "backspace" }, consumed: 1 });
  });
});

describe("parseKey", () => {
  it("strips control characters from pasted/batched input", () => {
    expect(parseKey(Buffer.from("hi\tthere"))).toEqual({ type: "character", value: "hithere" });
    expect(parseKey(Buffer.from("\r"))).toEqual({ type: "enter" });
  });
});

describe("stripPromptControlCharacters", () => {
  it("preserves printable text while removing C0 controls and DEL", () => {
    expect(stripPromptControlCharacters("safe\u001b[2Jafter\nnext\tvalue\u007f")).toBe(
      "safe[2Jafternextvalue",
    );
  });
});

describe("takeUntil", () => {
  it("releases the source iterator when stop wins, absorbing the late pull", async () => {
    let returned = false;
    let rejectNext: (error: Error) => void = () => {};
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<number>>((_, reject) => {
              rejectNext = reject;
            }),
          return: () => {
            returned = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };

    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });

    const consumed: number[] = [];
    const consume = (async () => {
      for await (const value of takeUntil(source, stopped)) consumed.push(value);
    })();

    stop();
    await consume;
    expect(consumed).toEqual([]);
    expect(returned).toBe(true);

    // The abandoned in-flight pull settles late (e.g. once the runner aborts
    // the underlying stream); it must not become an unhandled rejection.
    rejectNext(new Error("aborted"));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("releases a generator source blocked in next() once the pending pull settles", async () => {
    let cleaned = false;
    let rejectPull: (error: Error) => void = () => {};
    const gate = new Promise<never>((_, reject) => {
      rejectPull = reject;
    });
    async function* source(): AsyncGenerator<number> {
      try {
        yield 1;
        await gate; // hangs the second pull like a pending network read
        yield 2;
      } finally {
        cleaned = true;
      }
    }

    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const consumed: number[] = [];
    const consume = (async () => {
      for await (const value of takeUntil(source(), stopped)) consumed.push(value);
    })();

    await new Promise((resolve) => setImmediate(resolve));
    stop();
    await consume;
    expect(consumed).toEqual([1]);
    // `return()` queues behind the in-flight pull — cleanup cannot run yet.
    expect(cleaned).toBe(false);

    // The caller aborting the underlying stream settles the pull (mirrors the
    // renderer's Ctrl+C firing `result.abort()`); only then does the
    // generator's cleanup run.
    rejectPull(new Error("aborted"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(cleaned).toBe(true);
  });

  it("runs the source generator's cleanup when the consumer breaks", async () => {
    let cleaned = false;
    async function* source(): AsyncGenerator<number> {
      try {
        let i = 0;
        while (true) {
          yield i;
          i += 1;
        }
      } finally {
        cleaned = true;
      }
    }

    const never = new Promise<void>(() => {});
    for await (const value of takeUntil(source(), never)) {
      if (value === 2) break;
    }

    await new Promise((resolve) => setImmediate(resolve));
    expect(cleaned).toBe(true);
  });
});
