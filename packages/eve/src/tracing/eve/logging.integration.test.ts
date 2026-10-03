import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { expect, it, vi } from "vitest";
import { withCapture } from "#tracing/lib/index.js";
import { createLogger, logError } from "#internal/logging.js";

it("keeps logger-to-span error details behind the active output policy", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  try {
    for (const allowed of [false, true]) {
      const span = provider.getTracer("logger").startSpan(`logger-${allowed}`);
      const active = withCapture(trace.setSpan(context.active(), span), {
        emit: true,
        recordInputs: false,
        recordOutputs: allowed,
      });
      context.with(active, () =>
        logError(createLogger("test"), "operation failed", new Error("sensitive payload")),
      );
      span.end();
    }
    const [privateSpan, publicSpan] = exporter.getFinishedSpans();
    expect(privateSpan?.status.code).toBe(2);
    expect(privateSpan?.status.message).toBeUndefined();
    expect(privateSpan?.events).toEqual([]);
    expect(publicSpan?.status.message).toContain("sensitive payload");
    expect(publicSpan?.events[0]?.attributes?.["exception.message"]).toContain("sensitive payload");
  } finally {
    context.disable();
    manager.disable();
    consoleError.mockRestore();
    await provider.shutdown();
  }
});
