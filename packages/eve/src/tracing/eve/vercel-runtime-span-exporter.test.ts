import { afterEach, describe, expect, it, vi } from "vitest";

import { vercelRuntimeSpanExporter } from "./vercel-runtime-span-exporter.js";

const { serializeRequest } = vi.hoisted(() => ({
  serializeRequest: vi.fn(() => new TextEncoder().encode('{"resourceSpans":[]}')),
}));

vi.mock("@opentelemetry/otlp-transformer", () => ({
  JsonTraceSerializer: { serializeRequest },
}));

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
  serializeRequest.mockClear();
});

describe("Vercel runtime span export", () => {
  it("reports through the current Vercel request context", () => {
    const reportSpans = vi.fn();
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ telemetry: { reportSpans } }),
    };
    const result = vi.fn();

    vercelRuntimeSpanExporter().export([{}], result);

    expect(reportSpans).toHaveBeenCalledExactlyOnceWith({ resourceSpans: [] });
    expect(result).toHaveBeenCalledExactlyOnceWith({ code: 0 });
  });

  it("is a successful no-op without request telemetry", () => {
    const result = vi.fn();

    vercelRuntimeSpanExporter().export([{}], result);

    expect(serializeRequest).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledExactlyOnceWith({ code: 0 });
  });
});
