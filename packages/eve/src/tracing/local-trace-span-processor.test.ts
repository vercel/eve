import { beforeEach, describe, expect, it, vi } from "vitest";
import { JsonTraceSerializer } from "#compiled/@opentelemetry/otlp-transformer/index.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";
import {
  LocalTraceSpanProcessor,
  LOCAL_TRACE_SEGMENT_BYTES,
} from "#tracing/local-trace-span-processor.js";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}) }));
vi.mock("#shared/atomic-write-file.js", () => ({ atomicWriteFile: vi.fn(async () => {}) }));
vi.mock("#compiled/@opentelemetry/otlp-transformer/index.js", () => ({
  JsonTraceSerializer: { serializeRequest: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

const span = {
  attributes: {},
  spanContext: () => ({ traceId: "1".repeat(32), spanId: "2".repeat(16) }),
};

describe("local trace writer budgets", () => {
  it("bounds queued bytes before starting filesystem writes", async () => {
    vi.mocked(JsonTraceSerializer.serializeRequest).mockReturnValue(
      new Uint8Array(LOCAL_TRACE_SEGMENT_BYTES),
    );
    const processor = new LocalTraceSpanProcessor("/unused");
    for (let index = 0; index < 20; index++) processor.onEnd(span);
    await processor.forceFlush();
    expect(atomicWriteFile).toHaveBeenCalledTimes(8);
  });

  it("drops oversized segments and stops accepting spans after shutdown", async () => {
    vi.mocked(JsonTraceSerializer.serializeRequest).mockReturnValue(
      new Uint8Array(LOCAL_TRACE_SEGMENT_BYTES + 1),
    );
    const processor = new LocalTraceSpanProcessor("/unused");
    processor.onEnd(span);
    await processor.shutdown();
    processor.onEnd(span);
    expect(atomicWriteFile).not.toHaveBeenCalled();
    expect(JsonTraceSerializer.serializeRequest).toHaveBeenCalledOnce();
  });
});
