import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { serializeContext } from "#context/serialize.js";
import { readAgentChildTrace, withAgentChildTrace } from "#tracing/agent-child-trace.js";

describe("agent child trace scope", () => {
  it("isolates concurrent dispatches without serializing their caller context", async () => {
    const context = new ContextContainer();
    const key = new ContextKey<string>("test.agentChildTrace");
    context.setVirtualContext(key, "step-local");
    await contextStorage.run(context, async () => {
      await Promise.all(
        ["1", "2"].map((id) => {
          const trace = {
            originAudience: "private" as const,
            parentTraceContext: { spanId: id.repeat(16), traceFlags: 1, traceId: id.repeat(32) },
          };
          return withAgentChildTrace(trace, async () => {
            await Promise.resolve();
            expect(readAgentChildTrace()).toBe(trace);
            expect(contextStorage.getStore()?.get(key)).toBe("step-local");
            expect(serializeContext(contextStorage.getStore()!)).toEqual({});
          });
        }),
      );
    });
    expect(readAgentChildTrace()).toBeUndefined();
  });

  it("restores the outer scope when a nested dispatch fails", async () => {
    const trace = { originAudience: "public" as const };
    await withAgentChildTrace(trace, async () => {
      await expect(
        withAgentChildTrace({ originAudience: "private" }, async () => {
          throw new Error("failed");
        }),
      ).rejects.toThrow("failed");
      expect(readAgentChildTrace()).toBe(trace);
    });
    expect(readAgentChildTrace()).toBeUndefined();
  });
});
