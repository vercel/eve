import { describe, expect, it } from "vitest";

import {
  defineInstrumentation,
  disableInstrumentation,
  isInstrumentationDisabled,
  isInstrumentationProvider,
  type InstrumentationSetupContext,
} from "#public/instrumentation/index.js";

describe("defineInstrumentation", () => {
  it("keeps the legacy setup context constructible with only the agent name", () => {
    const context: InstrumentationSetupContext = { agentName: "weather" };

    expect(context).toEqual({ agentName: "weather" });
  });

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

  it("brands a legacy config-shaped declaration", () => {
    const config = defineInstrumentation({ functionId: "support", recordInputs: false });

    expect(isInstrumentationProvider(config)).toBe(true);
    expect(config.functionId).toBe("support");
    expect(config).toMatchObject({ functionId: "support", recordInputs: false });
  });

  it("infers terminal handler events from union-typed discriminants", () => {
    const provider = defineInstrumentation({
      events: {
        "action.completed": (event) => void [event.acceptedAtMs, event.outcome, event.usage],
        "action.failed": (event) => void [event.acceptedAtMs, event.errorCode, event.outcome],
        "session.completed": (event) => void event.sessionId,
        "step.attempt.completed": (event) => void event.scope,
        "turn.failed": (event) => void event.error,
      },
    });

    expect(isInstrumentationProvider(provider)).toBe(true);
  });

  it("exposes durable input request and resolution events", () => {
    const provider = defineInstrumentation({
      events: {
        "input.requested": (event) => void event.action.callId,
        "input.resolved": (event) => void event.outcome,
      },
    });

    expect(isInstrumentationProvider(provider)).toBe(true);
  });

  it("exposes channel delivery lifecycle events", () => {
    const provider = defineInstrumentation({
      events: {
        "channel.delivery.started": (event) => void event.delivery.deliveryId,
        "channel.delivery.completed": (event) => void event.outcome,
        "channel.delivery.failed": (event) => void event.errorCode,
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
