import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorId, createLogger, formatError, logError } from "#internal/logging.js";

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
