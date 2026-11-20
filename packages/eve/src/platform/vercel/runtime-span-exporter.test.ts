import { afterEach, describe, expect, it, vi } from "vitest";

import { vercelRuntimeSpanExporter } from "#platform/vercel/runtime-span-exporter.js";

const { serializeRequest } = vi.hoisted(() => ({
  serializeRequest: vi.fn(() => new TextEncoder().encode('{"resourceSpans":[]}')),
}));

vi.mock("#compiled/@opentelemetry/otlp-transformer/index.js", () => ({
  JsonTraceSerializer: { serializeRequest },
}));

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
  serializeRequest.mockClear();
});

describe("Vercel runtime span export", () => {
  it("reports through the current Vercel request context once the serializer is loaded", async () => {
    const reportSpans = vi.fn();
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ telemetry: { reportSpans } }),
    };
    const exporter = vercelRuntimeSpanExporter();
    await exporter.forceFlush?.();
    const result = vi.fn();

    exporter.export([{}], result);

    expect(reportSpans).toHaveBeenCalledExactlyOnceWith({ resourceSpans: [] });
    expect(result).toHaveBeenCalledExactlyOnceWith({ code: 0 });
  });

  it("reports spans that end before the serializer finishes loading", async () => {
    const reportSpans = vi.fn();
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({ telemetry: { reportSpans } }),
    };
    const exporter = vercelRuntimeSpanExporter();
    const result = vi.fn();

    exporter.export([{}], result);
    await exporter.forceFlush?.();
    await vi.waitFor(() => expect(result).toHaveBeenCalledExactlyOnceWith({ code: 0 }));

    expect(reportSpans).toHaveBeenCalledExactlyOnceWith({ resourceSpans: [] });
  });

  it("is a successful no-op without request telemetry", () => {
    const result = vi.fn();

    vercelRuntimeSpanExporter().export([{}], result);

    expect(serializeRequest).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledExactlyOnceWith({ code: 0 });
  });
});
