import { describe, expect, it } from "vitest";

import {
  defineInstrumentation,
  disableInstrumentation,
  isInstrumentationDisabled,
} from "#public/instrumentation/index.js";

describe("defineInstrumentation", () => {
  it("brands a provider-shaped declaration", () => {
    const provider = defineInstrumentation({
      events: {
        "session.started"(event) {
          void event.sessionId;
        },
      },
    });

    expect(isInstrumentationProvider(provider)).toBe(true);
  });

  it("preserves a provider trace policy", () => {
    const tracePolicy = ({ audience }: { audience: string }) => ({
      emit: true as const,
      recordInputs: audience === "public",
      recordOutputs: false,
    });
    const provider = defineInstrumentation({ tracePolicy });

    expect(provider.tracePolicy).toBe(tracePolicy);
  });

  it("infers terminal handler events from union-typed discriminants", () => {
    const provider = defineInstrumentation({
      events: {
        "call.settled": (event) => void [event.acceptedAtMs, event.errorCode, event.outcome],
        "session.ended": (event) => void event.sessionId,
        "model.settled": (event) => void event.scope,
        "memory.operation.settled": (event) => {
          if (event.outcome === "completed") void event.outputRecords;
        },
        "turn.settled": (event) => void event.error,
      },
    });

    expect(isInstrumentationProvider(provider)).toBe(true);
    defineInstrumentation({
      events: {
        // @ts-expect-error Action hooks were replaced by tool.call hooks.
        "action.started": () => {},
      },
    });
  });

  it("exposes durable input request and resolution events", () => {
    const provider = defineInstrumentation({
      events: {
        "interaction.opened": (event) => void event.call?.callId,
        "interaction.settled": (event) => void event.outcome,
      },
    });

    expect(isInstrumentationProvider(provider)).toBe(true);
  });

  it("exposes channel delivery lifecycle events", () => {
    const provider = defineInstrumentation({
      events: {
        "delivery.consumed": (event) => void event.deliveryId,
        "delivery.settled": (event) => void event.outcome,
      },
    });

    expect(isInstrumentationProvider(provider)).toBe(true);
  });

  it("preserves the authored fields", () => {
    const setup = (): void => {};
    const declaration = defineInstrumentation({ setup });

    expect(declaration).toMatchObject({ setup });
  });
});

describe("isInstrumentationProvider", () => {
  it("rejects a value that never went through defineInstrumentation", () => {
    expect(isInstrumentationProvider({ events: {} })).toBe(false);
  });

  it.each([[null], [undefined], ["provider"], [42]])("rejects %p", (value) => {
    expect(isInstrumentationProvider(value)).toBe(false);
  });
});

describe("disableInstrumentation", () => {
  it("is recognizable as a disabled slot rather than a provider", () => {
    const disabled = disableInstrumentation();

    expect(isInstrumentationDisabled(disabled)).toBe(true);
    expect(isInstrumentationProvider(disabled)).toBe(false);
  });

  it("does not treat a provider as a disabled slot", () => {
    expect(isInstrumentationDisabled(defineInstrumentation({}))).toBe(false);
  });
});

import { isInstrumentationProvider } from "#instrumentation/provider.js";
