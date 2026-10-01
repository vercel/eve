import { describe, expect, it, vi } from "vitest";
import { createTraceEngine } from "#tracing/core/engine.js";
import type { TraceBackend, SpanWriter, PreparedSpan } from "#tracing/core/types.js";

describe("trace engine failure and capture boundary", () => {
  it("runs application code exactly once when context fails and preserves application errors", () => {
    const writer: SpanWriter = {
      reference: { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      fail: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const backend: TraceBackend = {
      start: () => writer,
      current: () => undefined,
      run() {
        throw new Error("context unavailable");
      },
    };
    const engine = createTraceEngine({ backend });
    const operation = engine.start(
      { type: "tool", operationId: "tool", name: "execute_tool lookup", attributes: {} },
      { emit: true, recordInputs: false, recordOutputs: false },
    );
    const execute = vi.fn(() => "result");
    expect(operation.run(execute)).toBe("result");
    expect(execute).toHaveBeenCalledTimes(1);
    const error = new Error("application");
    backend.run = (_reference, _capture, callback) => callback();
    const fail = vi.fn(() => {
      throw error;
    });
    expect(() => operation.run(fail)).toThrow(error);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("filters denied initial and late content and closes each operation once", () => {
    const writer: SpanWriter = {
      reference: { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      fail: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const start = vi.fn((_span: PreparedSpan) => writer);
    const backend: TraceBackend = {
      start,
      current: () => undefined,
      run: (_reference, _capture, callback) => callback(),
    };
    const operation = createTraceEngine({ backend }).start(
      {
        type: "tool",
        operationId: "tool",
        name: "execute_tool lookup",
        attributes: { "gen_ai.tool.name": "lookup", "gen_ai.tool.call.arguments": "secret" },
      },
      { emit: true, recordInputs: false, recordOutputs: false },
    );
    expect(start.mock.calls[0]![0].attributes).toEqual({ "gen_ai.tool.name": "lookup" });
    operation.setAttribute("gen_ai.tool.call.result", "secret");
    operation.fail(new Error("secret"));
    operation.end();
    operation.end();
    expect(writer.setAttribute).not.toHaveBeenCalled();
    expect(writer.fail).toHaveBeenCalledWith(undefined, undefined);
    expect(writer.end).toHaveBeenCalledTimes(1);
  });
});
