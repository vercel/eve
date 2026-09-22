import { describe, expect, it, vi } from "vitest";

import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import type { UnclassifiedTraceCaptureContext } from "#shared/trace-policy.js";

const trace: UnclassifiedTraceCaptureContext = {
  agentName: "support",
  audience: "private",
  channel: {
    kind: "channel:slack",
    metadata: { teamId: "team-1" },
    state: { visibility: "private" },
  },
  environment: "production",
  mode: "conversation",
  principalType: "user",
};

function event(error?: Error) {
  return {
    error,
    idempotencyKey: "turn:session-1:turn-1",
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.failed" as const,
  };
}

describe("instrumentation classification", () => {
  it("shares one trace and record classification with every provider", async () => {
    const firstPolicy = vi.fn(() => ({
      emit: true as const,
      recordInputs: false,
      recordOutputs: true,
    }));
    const secondPolicy = vi.fn(() => ({
      emit: true as const,
      recordInputs: false,
      recordOutputs: true,
    }));
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const runWithClassification = vi.fn(
      async (_classification: unknown, execute: () => void | PromiseLike<void>) => await execute(),
    );
    const classificationPolicy = vi.fn(async (input: { boundary: string }) =>
      input.boundary === "trace" ? "private" : "error",
    );
    const hooks = await createInstrumentationHooks([
      {
        classificationPolicy,
        events: { "turn.failed": firstHandler },
        name: "classifier",
        tracePolicy: firstPolicy,
      },
      {
        events: { "turn.failed": secondHandler },
        name: "consumer",
        runWithClassification,
        tracePolicy: secondPolicy,
      },
    ]).prepareTrace!(trace);
    const failure = new Error("private failure");

    await hooks.publish(event(failure));

    expect(firstPolicy).toHaveBeenCalledWith({ ...trace, classification: "private" });
    expect(secondPolicy).toHaveBeenCalledWith({ ...trace, classification: "private" });
    expect(classificationPolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        boundary: "record",
        record: expect.objectContaining({ error: failure }),
        traceClassification: "private",
      }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(firstHandler).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure }),
      expect.objectContaining({ classification: "error" }),
    );
    expect(secondHandler).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure }),
      expect.objectContaining({ classification: "error" }),
    );
    expect(runWithClassification).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("applies internal capture ceilings before classification without narrowing lifecycle providers", async () => {
    const classifiedRecords: unknown[] = [];
    const lifecycleEvents: unknown[] = [];
    const hooks = await createInstrumentationHooks({
      parallel: [
        {
          classificationPolicy(input) {
            if (input.boundary === "record") classifiedRecords.push(input.record);
            return input.boundary === "trace" ? "private" : "classified";
          },
          name: "classifier",
          tracePolicy: () => ({
            emit: true,
            recordInputs: true,
            recordOutputs: true,
          }),
        },
        {
          events: {
            "channel.delivery.started": (event) => void lifecycleEvents.push(event),
          },
          name: "private-audit",
          tracePolicy: () => ({
            emit: true,
            recordInputs: true,
            recordOutputs: false,
          }),
        },
      ],
      serialBefore: [
        {
          name: "eve.otel",
          projectEvent(event) {
            return event.type === "channel.delivery.started"
              ? { ...event, input: undefined }
              : event;
          },
          tracePolicy: () => ({
            emit: true,
            recordInputs: true,
            recordOutputs: true,
          }),
        },
      ],
    }).prepareTrace!(trace);

    await hooks.publish({
      delivery: {
        channelKind: "channel:slack",
        channelName: "slack",
        deliveryId: "delivery-1",
      },
      idempotencyKey: "channel-delivery-1",
      input: { message: "private customer message" },
      rootSessionId: "session-1",
      sessionId: "session-1",
      type: "channel.delivery.started",
    });

    expect(classifiedRecords).toEqual([
      expect.objectContaining({ input: undefined, type: "channel.delivery.started" }),
    ]);
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        input: { message: "private customer message" },
        type: "channel.delivery.started",
      }),
    ]);
  });

  it("rejects multiple classification policies", () => {
    expect(() =>
      createInstrumentationHooks([
        { classificationPolicy: () => "first", name: "first" },
        { classificationPolicy: () => "second", name: "second" },
      ]),
    ).toThrow(/classificationPolicy more than once.*first, second/u);
  });

  it("fails closed when trace classification fails", async () => {
    const observed = vi.fn();
    const hooks = await createInstrumentationHooks([
      {
        classificationPolicy: async () => {
          throw new Error("trace failed");
        },
        name: "classifier",
      },
      { events: { "turn.failed": observed }, name: "consumer" },
    ]).prepareTrace!(trace);

    await hooks.publish(event());

    expect(observed).not.toHaveBeenCalled();
  });

  it("fails closed when record classification fails", async () => {
    const observed = vi.fn();
    const hooks = await createInstrumentationHooks([
      {
        classificationPolicy: async (input) => {
          if (input.boundary === "record") throw new Error("record failed");
          return "accepted";
        },
        name: "classifier",
      },
      { events: { "turn.failed": observed }, name: "consumer" },
    ]).prepareTrace!(trace);

    await hooks.publish(event());

    expect(observed).not.toHaveBeenCalled();
  });
});
