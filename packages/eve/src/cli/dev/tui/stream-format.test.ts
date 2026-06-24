import { describe, expect, it } from "vitest";

import {
  formatCompactTokenCount,
  formatTokenFlow,
  isIncompletePaste,
  nextKey,
  parseKey,
  sanitizePastedText,
  stripPasteStart,
  stripPromptControlCharacters,
  takeUntil,
} from "./stream-format.js";

const FLOW_GLYPHS = { arrowUp: "↑", arrowDown: "↓" };

describe("sanitizePastedText", () => {
  it("keeps newlines and tabs but drops other control characters and ESC", () => {
    expect(sanitizePastedText("a\tb\nc")).toBe("a\tb\nc");
    expect(sanitizePastedText("a\x1b[31mb\x07c")).toBe("a[31mbc");
  });

  it("normalizes CRLF and lone CR to LF", () => {
    expect(sanitizePastedText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("drops C1 control bytes that terminals read as control introducers", () => {
    // 0x9b is single-byte CSI, 0x9d is OSC: leaving them in would let a paste
    // smuggle in an escape sequence.
    expect(sanitizePastedText("abc")).toBe("abc");
  });
});

describe("incomplete bracketed paste", () => {
  it("flags a paste whose end marker hasn't arrived, and clears once it has", () => {
    expect(isIncompletePaste("\x1b[200~partial")).toBe(true);
    expect(isIncompletePaste("\x1b[200~done\x1b[201~")).toBe(false);
    expect(isIncompletePaste("plain text")).toBe(false);
  });

  it("strips the start marker so recovery can read the buffered payload", () => {
    expect(stripPasteStart("\x1b[200~oops")).toBe("oops");
    expect(stripPasteStart("no marker")).toBe("no marker");
  });
});

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
    expect(nextKey("hello")).toEqual({
      key: { type: "text", value: "hello", framing: "unframed" },
      consumed: 5,
    });
  });

  it("decodes a bracketed paste as one token, preserving newlines", () => {
    const buffer = "\x1b[200~first\nsecond\x1b[201~";
    expect(nextKey(buffer)).toEqual({
      key: { type: "text", value: "first\nsecond", framing: "bracketed-paste" },
      consumed: buffer.length,
    });
  });

  it("sanitizes the paste payload as it decodes, not just at insert time", () => {
    // A hostile frame carrying ESC and a bell must come out stripped, pinning
    // the sanitize call on the decode path itself.
    const buffer = "\x1b[200~a\x1b[31mb\x07c\x1b[201~";
    expect(nextKey(buffer)).toEqual({
      key: { type: "text", value: "a[31mbc", framing: "bracketed-paste" },
      consumed: buffer.length,
    });
  });

  it("waits for the bracketed-paste end marker before decoding", () => {
    expect(nextKey("\x1b[200~still arriving")).toEqual({ consumed: 0, incomplete: true });
  });

  it("re-tokenizes input that follows a bracketed paste", () => {
    const buffer = "\x1b[200~hi\x1b[201~\r";
    const token = nextKey(buffer);
    expect(token).toEqual({
      key: { type: "text", value: "hi", framing: "bracketed-paste" },
      consumed: buffer.length - 1,
    });
    expect(nextKey(buffer.slice(token.consumed))).toEqual({ key: { type: "enter" }, consumed: 1 });
  });

  it("decodes Shift+Enter as a newline while a bare Enter still submits", () => {
    expect(nextKey("\x1b[27;2;13~")).toEqual({ key: { type: "newline" }, consumed: 10 });
    expect(nextKey("\x1b[13;2u")).toEqual({ key: { type: "newline" }, consumed: 7 });
    expect(nextKey("\r")).toEqual({ key: { type: "enter" }, consumed: 1 });
  });

  it("stops a printable run at a control byte", () => {
    expect(nextKey("ab\rcd")).toEqual({
      key: { type: "text", value: "ab", framing: "unframed" },
      consumed: 2,
    });
  });

  it("decodes a lone control byte", () => {
    expect(nextKey("\r")).toEqual({ key: { type: "enter" }, consumed: 1 });
    expect(nextKey("\u007f")).toEqual({ key: { type: "backspace" }, consumed: 1 });
  });
});

describe("parseKey", () => {
  it("strips control characters from pasted/batched input", () => {
    expect(parseKey(Buffer.from("hi\tthere"))).toEqual({
      type: "text",
      value: "hithere",
      framing: "unframed",
    });
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
