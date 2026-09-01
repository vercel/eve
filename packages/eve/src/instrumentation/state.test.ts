import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  actionIdempotencyKey,
  type InstrumentationAttemptScope,
} from "#instrumentation/lifecycle.js";
import {
  abandonInstrumentationState,
  instrumentationStateSlot,
  isInstrumentationStateAbandoned,
  rememberInstrumentationActionScope,
  releaseAllInstrumentationAttemptState,
  releaseAllInstrumentationState,
  takeInstrumentationActionScopeForCall,
} from "#instrumentation/state.js";
import { preserveSerializedInstrumentationState } from "#instrumentation/state.js";

describe("instrumentation state", () => {
  it("survives a serialized step boundary", async () => {
    const context = new ContextContainer();
    contextStorage.run(context, () => {
      instrumentationStateSlot("sink", "model:1", { attemptId: "attempt-1" }).set({
        rowId: "row-1",
      });
    });
    const restored = await deserializeContext(await serializeContext(context));
    contextStorage.run(restored, () => {
      expect(instrumentationStateSlot("sink", "model:1").get()).toEqual({ rowId: "row-1" });
    });
  });

  it("isolates providers and operations", () => {
    contextStorage.run(new ContextContainer(), () => {
      instrumentationStateSlot("a", "turn:1").set("a-1");
      instrumentationStateSlot("b", "turn:1").set("b-1");
      instrumentationStateSlot("a", "turn:2").set("a-2");
      expect(instrumentationStateSlot("a", "turn:1").get()).toBe("a-1");
      expect(instrumentationStateSlot("b", "turn:1").get()).toBe("b-1");
      expect(instrumentationStateSlot("a", "turn:2").get()).toBe("a-2");
    });
  });

  it("correlates same-turn actions with their stored attempt scopes", () => {
    const first: InstrumentationAttemptScope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    const second: InstrumentationAttemptScope = {
      ...first,
      attemptId: "session-1:turn-1:1:0",
      stepIndex: 1,
    };
    const firstKey = actionIdempotencyKey(first.sessionId, first.turnId, "call-1");
    const secondKey = actionIdempotencyKey(second.sessionId, second.turnId, "call-2");

    contextStorage.run(new ContextContainer(), () => {
      rememberInstrumentationActionScope(firstKey, first);
      rememberInstrumentationActionScope(secondKey, second);

      expect(takeInstrumentationActionScopeForCall(second.sessionId, "call-2")).toEqual({
        idempotencyKey: secondKey,
        scope: second,
      });
      expect(takeInstrumentationActionScopeForCall(first.sessionId, "call-1")).toEqual({
        idempotencyKey: firstKey,
        scope: first,
      });
    });
  });

  it("rejects values that cannot survive serialization", () => {
    contextStorage.run(new ContextContainer(), () => {
      expect(() => instrumentationStateSlot("sink", "turn:1").set(new Date() as never)).toThrow(
        TypeError,
      );
    });
  });

  it("revokes late reads and writes", () => {
    contextStorage.run(new ContextContainer(), () => {
      const lease = instrumentationStateSlot("sink", "turn:1");
      lease.set("before");
      lease.revoke();
      lease.set("after");
      expect(lease.get()).toBeUndefined();
      expect(instrumentationStateSlot("sink", "turn:1").get()).toBe("before");
    });
  });

  it("does not expose mutable durable state through a retained read", () => {
    contextStorage.run(new ContextContainer(), () => {
      const original = { nested: { count: 1 } };
      const lease = instrumentationStateSlot("sink", "turn:1");
      lease.set(original);
      original.nested.count = 2;

      const retained = lease.get() as { nested: { count: number } };
      lease.revoke();

      expect(Object.isFrozen(retained)).toBe(true);
      expect(Object.isFrozen(retained.nested)).toBe(true);
      expect(Reflect.set(retained.nested, "count", 3)).toBe(false);
      expect(instrumentationStateSlot("sink", "turn:1").get()).toEqual({ nested: { count: 1 } });
    });
  });

  it("releases exact and attempt-owned state", () => {
    contextStorage.run(new ContextContainer(), () => {
      instrumentationStateSlot("sink", "model:1", { attemptId: "attempt-1" }).set("one");
      instrumentationStateSlot("sink", "model:2", { attemptId: "attempt-2" }).set("two");
      releaseAllInstrumentationState("model:2");
      releaseAllInstrumentationAttemptState("attempt-1");
      expect(instrumentationStateSlot("sink", "model:1").get()).toBeUndefined();
      expect(instrumentationStateSlot("sink", "model:2").get()).toBeUndefined();
    });
  });

  it("preserves state from a discarded step", () => {
    expect(
      preserveSerializedInstrumentationState(
        { authored: "original" },
        {
          "eve.harness.instrumentationState": { state: true },
        },
      ),
    ).toEqual({
      authored: "original",
      "eve.harness.instrumentationState": { state: true },
    });
  });

  it("persists abandonment across serialization", async () => {
    const context = new ContextContainer();
    contextStorage.run(context, () => {
      abandonInstrumentationState("sink", "model:1", { attemptId: "attempt-1" });
    });
    const restored = await deserializeContext(await serializeContext(context));
    contextStorage.run(restored, () => {
      expect(isInstrumentationStateAbandoned("sink", "model:1")).toBe(true);
    });
  });
});
