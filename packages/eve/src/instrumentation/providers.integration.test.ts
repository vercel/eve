import { beforeEach, describe, expect, it } from "vitest";

import { turnIdempotencyKey } from "#instrumentation/lifecycle.js";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
} from "#instrumentation/providers.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";

const REGISTRY_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-providers");
const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("authored instrumentation provider dispatch", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_GLOBAL_KEY];
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
  });

  it("awaits setup in slot order while event handlers overlap", async () => {
    const firstSetup = deferred();
    const firstHandler = deferred();
    const secondHandler = deferred();
    const order: string[] = [];

    const firstRegistration = registerInstrumentationProvider({
      agentName: "weather",
      slot: "first",
      value: defineInstrumentation({
        events: {
          "turn.started": async () => {
            order.push("first:handler");
            await firstHandler.promise;
          },
        },
        setup: async () => {
          order.push("first:setup");
          await firstSetup.promise;
          order.push("first:setup-complete");
        },
      }),
    });

    expect(order).toEqual(["first:setup"]);
    firstSetup.resolve();
    await firstRegistration;

    await registerInstrumentationProvider({
      agentName: "weather",
      slot: "second",
      value: defineInstrumentation({
        events: {
          "turn.started": async () => {
            order.push("second:handler");
            await secondHandler.promise;
          },
        },
        setup: () => void order.push("second:setup"),
      }),
    });

    expect(order).toEqual(["first:setup", "first:setup-complete", "second:setup"]);

    const runtime = finalizeInstrumentationProviders({ serviceName: "weather" });
    const publication = runtime.hooks.publish({
      idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
      rootSessionId: "session-1",
      sequence: 0,
      sessionId: "session-1",
      turnId: "turn-1",
      type: "turn.started",
    });

    expect(order).toEqual([
      "first:setup",
      "first:setup-complete",
      "second:setup",
      "first:handler",
      "second:handler",
    ]);
    firstHandler.resolve();
    secondHandler.resolve();
    await publication;
  });
});
