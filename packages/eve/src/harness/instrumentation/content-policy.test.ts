import { afterEach, describe, expect, it, vi } from "vitest";

import {
  instrumentationHooksForAudience,
  instrumentationHooksForDecision,
  shouldCaptureInstrumentationContent,
} from "#harness/instrumentation/content-policy.js";
import type { InstrumentationHooks } from "#harness/instrumentation/lifecycle.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("instrumentation content policy", () => {
  it("captures only public content in hosted workers", () => {
    expect(shouldCaptureInstrumentationContent("public")).toBe(true);
    expect(shouldCaptureInstrumentationContent("private")).toBe(false);
    expect(shouldCaptureInstrumentationContent("unknown")).toBe(false);
  });

  it("keeps the local unknown-audience exception without admitting private content", () => {
    vi.stubEnv("EVE_DEV", "1");

    expect(shouldCaptureInstrumentationContent("public")).toBe(true);
    expect(shouldCaptureInstrumentationContent("private")).toBe(false);
    expect(shouldCaptureInstrumentationContent("unknown")).toBe(true);
  });

  it("strips content before publishing to hosted providers", async () => {
    const publish = vi.fn();
    const hooks: InstrumentationHooks = { capturesContent: true, publish };
    const restricted = instrumentationHooksForAudience(hooks, "private");

    await restricted?.publish({
      callId: "call-1",
      idempotencyKey: "action-1",
      input: { secret: "value" },
      kind: "tool-call",
      name: "lookup",
      scope: {
        attemptId: "attempt-1",
        attemptIndex: 0,
        sessionId: "session-1",
        stepIndex: 0,
        turnId: "turn-1",
      },
      type: "action.started",
    });

    expect(restricted?.capturesContent).toBe(false);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ input: undefined }));
  });

  it("applies directional trace capture before publishing", async () => {
    const publish = vi.fn();
    const hooks: InstrumentationHooks = { capturesContent: true, publish };
    const restricted = instrumentationHooksForDecision(hooks, {
      action: "record",
      recordInputs: true,
      recordOutputs: false,
    });

    await restricted?.publish({
      callId: "call-1",
      idempotencyKey: "action-1",
      input: { secret: "input" },
      kind: "tool-call",
      name: "lookup",
      scope: {
        attemptId: "attempt-1",
        attemptIndex: 0,
        sessionId: "session-1",
        stepIndex: 0,
        turnId: "turn-1",
      },
      type: "action.started",
    });
    await restricted?.publish({
      idempotencyKey: "action-1",
      outcome: "completed",
      output: { output: { secret: "output" }, type: "result" },
      scope: {
        attemptId: "attempt-1",
        attemptIndex: 0,
        sessionId: "session-1",
        stepIndex: 0,
        turnId: "turn-1",
      },
      type: "action.completed",
    });

    expect(restricted?.capturesContent).toBe(true);
    expect(publish.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ input: { secret: "input" } }),
    );
    expect(publish.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ output: { type: "result" } }),
    );
  });
});
