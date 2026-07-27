import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Span } from "#compiled/@opentelemetry/api/index.js";
import { SpanStatusCode } from "#compiled/@opentelemetry/api/index.js";
import {
  createErrorId,
  createLogger,
  formatError,
  logError,
  recordErrorOnSpan,
  setLogRecordSubscriber,
  type LogRecord,
} from "#internal/logging.js";

/** Active span seen by the logger; `undefined` keeps span recording off. */
let activeSpan: Span | undefined;

vi.mock("#compiled/@opentelemetry/api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#compiled/@opentelemetry/api/index.js")>();
  return {
    ...actual,
    trace: { ...actual.trace, getActiveSpan: () => activeSpan },
  };
});

// ---------------------------------------------------------------------------
// createErrorId
// ---------------------------------------------------------------------------

describe("createErrorId", () => {
  it("returns a unique opaque string each call", () => {
    const a = createErrorId();
    const b = createErrorId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

describe("formatError", () => {
  it("pins name and message fields and reuses the provided errorId", () => {
    const error = new TypeError("bad input");
    const out = formatError(error, "fixed-id");

    expect(out).toMatchObject({
      errorId: "fixed-id",
      name: "TypeError",
      message: expect.stringContaining("bad input"),
    });
    expect(typeof out.detail).toBe("string");
  });

  it("walks cause chain so upstream responseBody surfaces in detail", () => {
    const inner = Object.assign(new Error("upstream 400"), {
      responseBody: '{"message":"invalid input"}',
      statusCode: 400,
    });
    const outer = new Error("gateway wrap", { cause: inner });

    const out = formatError(outer);

    // The inspect dump should carry both the outer message and the
    // inner cause's responseBody so operators can grep either side.
    expect(out.detail).toContain("gateway wrap");
    expect(out.detail).toContain("upstream 400");
    expect(out.detail).toContain("responseBody");
    expect(out.detail).toContain("invalid input");
  });

  it("does not include name when the throwable is not an Error", () => {
    const out = formatError("raw string");
    expect(out.name).toBeUndefined();
    expect(out.message).toBe("raw string");
  });

  it("extracts name and message off plain-object throwables (post structured-clone)", () => {
    // Workflow step boundaries strip Errors to plain objects via
    // structured clone. `formatError` must still surface `name` so
    // `emitTerminalSessionFailureStep` can derive a useful `code`,
    // and `message` so the user-visible event isn't JSON-stringified.
    const out = formatError({
      name: "EveAttachmentError",
      message: "image exceeds 5 megabytes",
      kind: "resolver-threw",
    });
    expect(out.name).toBe("EveAttachmentError");
    expect(out.message).toBe("image exceeds 5 megabytes");
  });
});

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

describe("createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes every line with the namespace", () => {
    const logger = createLogger("slack.route");
    logger.info("hello");
    expect(logSpy).toHaveBeenCalledWith("[eve:slack.route] hello");
  });

  it("routes warn to console.warn and error to console.error", () => {
    const logger = createLogger("harness");
    logger.warn("a warning");
    logger.error("an error");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("delivers structured records to the registered subscriber instead of the console", () => {
    const records: LogRecord[] = [];
    setLogRecordSubscriber((record) => records.push(record));
    try {
      const logger = createLogger("harness.tool-loop");
      const cause = Object.assign(new Error("upstream"), { statusCode: 429 });
      logger.error("tool execution failed", { toolName: "always_fail", error: cause });

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        level: "error",
        namespace: "harness.tool-loop",
        message: "tool execution failed",
        fields: {
          toolName: "always_fail",
          error: { message: expect.stringContaining("upstream") as string },
        },
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      setLogRecordSubscriber(undefined);
    }

    const logger = createLogger("harness.tool-loop");
    logger.error("after unsubscribe");
    expect(errorSpy).toHaveBeenCalledWith("[eve:harness.tool-loop] after unsubscribe");
  });

  it("falls back to the console when the subscriber throws", () => {
    setLogRecordSubscriber(() => {
      throw new Error("subscriber broke");
    });
    try {
      createLogger("cli").error("still visible");
      expect(errorSpy).toHaveBeenCalledWith("[eve:cli] still visible");
    } finally {
      setLogRecordSubscriber(undefined);
    }
  });

  it("renders Error fields through formatError so cause chain flows through", () => {
    const logger = createLogger("slack.route");
    const cause = Object.assign(new Error("upstream"), { statusCode: 429 });
    const error = new TypeError("wrap", { cause });

    logger.error("delivery failed", { error });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const call = errorSpy.mock.calls[0];
    expect(call).toBeDefined();
    const [line, payload] = call!;
    expect(line).toBe("[eve:slack.route] delivery failed");
    expect(payload).toMatchObject({
      error: {
        message: expect.stringContaining("wrap"),
        name: "TypeError",
        errorId: expect.any(String),
        detail: expect.stringContaining("upstream"),
      },
    });
  });

  it("omits the payload argument when no fields are provided", () => {
    const logger = createLogger("ns");
    logger.info("plain line");
    expect(logSpy).toHaveBeenCalledWith("[eve:ns] plain line");
  });

  it("drops undefined field values so optional context does not bloat logs", () => {
    const logger = createLogger("ns");
    logger.warn("partial", { reason: "network", attempt: undefined });
    const call = warnSpy.mock.calls[0];
    expect(call).toBeDefined();
    const [, payload] = call!;
    expect(payload).toEqual({ reason: "network" });
  });
});

// ---------------------------------------------------------------------------
// EVE_LOG_LEVEL filtering
// ---------------------------------------------------------------------------

describe("level filtering", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("suppresses below-threshold levels when EVE_LOG_LEVEL is set", () => {
    vi.stubEnv("EVE_LOG_LEVEL", "warn");
    const logger = createLogger("ns");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("is read per call so the threshold can change at runtime", () => {
    vi.stubEnv("EVE_LOG_LEVEL", "error");
    const logger = createLogger("ns");
    logger.warn("first");
    expect(warnSpy).not.toHaveBeenCalled();
    vi.stubEnv("EVE_LOG_LEVEL", "debug");
    logger.warn("second");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults to info (debug opt-in) when EVE_LOG_LEVEL is unset", () => {
    vi.stubEnv("EVE_LOG_LEVEL", "");
    const logger = createLogger("ns");
    logger.debug("d");
    logger.info("i");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[eve:ns] i");
  });

  it("keeps the info default regardless of NODE_ENV", () => {
    vi.stubEnv("EVE_LOG_LEVEL", "");
    vi.stubEnv("NODE_ENV", "production");
    const logger = createLogger("ns");
    logger.debug("d");
    logger.info("i");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[eve:ns] i");
  });
});

// ---------------------------------------------------------------------------
// logError
// ---------------------------------------------------------------------------

describe("logError", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes a non-Error throwable through formatError and returns its id", () => {
    const logger = createLogger("ns");
    const id = logError(logger, "boom", { name: "WeirdError", message: "post-clone" });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    const call = errorSpy.mock.calls[0];
    expect(call).toBeDefined();
    const [line, payload] = call!;
    expect(line).toBe("[eve:ns] boom");
    expect(payload).toMatchObject({
      error: { name: "WeirdError", message: "post-clone", errorId: id },
    });
  });

  it("captures the full detail/stack of an Error throwable", () => {
    const logger = createLogger("ns");
    const cause = Object.assign(new Error("upstream"), { statusCode: 503 });
    logError(logger, "tool failed", new Error("wrap", { cause }), { toolName: "search" });

    const call = errorSpy.mock.calls[0];
    expect(call).toBeDefined();
    const [, payload] = call!;
    expect(payload).toMatchObject({
      toolName: "search",
      error: {
        message: expect.stringContaining("wrap"),
        detail: expect.stringContaining("upstream"),
      },
    });
  });
});

// ---------------------------------------------------------------------------
// span recording guard
// ---------------------------------------------------------------------------

interface FakeSpan {
  addEvent: ReturnType<typeof vi.fn>;
  recordException: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  span: Span;
}

/**
 * Mirrors the OTel SDK: a span that has ended is no longer recording, and
 * mutating it logs "Operation attempted on ended Span" — modeled here as a
 * throw so any unguarded write fails the test loudly.
 */
function makeFakeSpan(isRecording: boolean): FakeSpan {
  const mutate = (name: string) =>
    vi.fn((..._args: unknown[]) => {
      if (!isRecording) {
        throw new Error(`Operation attempted on ended Span: ${name}`);
      }
    });
  const addEvent = mutate("addEvent");
  const recordException = mutate("recordException");
  const setStatus = mutate("setStatus");
  const setAttribute = mutate("setAttribute");

  const span: Span = {
    addEvent(name, attributes) {
      addEvent(name, attributes);
      return this;
    },
    end() {},
    isRecording: () => isRecording,
    recordException(exception) {
      recordException(exception);
    },
    setAttribute(key, value) {
      setAttribute(key, value);
      return this;
    },
    setStatus(status) {
      setStatus(status);
      return this;
    },
    spanContext: () => ({ spanId: "span-id", traceFlags: 1, traceId: "trace-id" }),
  };

  return { addEvent, recordException, setStatus, span };
}

describe("span recording guard", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    activeSpan = undefined;
    vi.restoreAllMocks();
  });

  it("skips writes to an ended active span", () => {
    const span = makeFakeSpan(false);
    activeSpan = span.span;

    expect(() => createLogger("ns").error("boom", { error: new Error("x") })).not.toThrow();

    expect(span.setStatus).not.toHaveBeenCalled();
    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.addEvent).not.toHaveBeenCalled();
  });

  it("skips writes to an ended span passed directly", () => {
    const span = makeFakeSpan(false);

    expect(() => recordErrorOnSpan(span.span, new Error("x"))).not.toThrow();

    expect(span.setStatus).not.toHaveBeenCalled();
    expect(span.recordException).not.toHaveBeenCalled();
  });

  it("still records an error on a recording active span", () => {
    const span = makeFakeSpan(true);
    activeSpan = span.span;

    createLogger("ns").error("boom", { error: new Error("x") });

    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: "x" });
    expect(span.recordException).toHaveBeenCalledTimes(1);
  });

  it("still adds an event on a recording active span when no error is present", () => {
    const span = makeFakeSpan(true);
    activeSpan = span.span;

    createLogger("ns").error("plain", { foo: "bar" });

    expect(span.addEvent).toHaveBeenCalledWith("plain", { foo: "bar" });
    expect(span.setStatus).not.toHaveBeenCalled();
  });

  it("still records on a recording span passed directly", () => {
    const span = makeFakeSpan(true);

    recordErrorOnSpan(span.span, new Error("x"));

    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: "x" });
    expect(span.recordException).toHaveBeenCalledTimes(1);
  });
});
