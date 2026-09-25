import { describe, expect, it } from "vitest";
import { GenerationSteering } from "#harness/generation-steering.js";
import {
  createMessageAppendedEvent,
  createReasoningAppendedEvent,
  createInputRequestedEvent,
  createStepFailedEvent,
  createTurnCompletedEvent,
} from "#protocol/message.js";

describe("GenerationSteering", () => {
  it("observes a correction received before generation starts", () => {
    const steering = new AbortController();
    steering.abort();
    const generation = new GenerationSteering({ steeringSignal: steering.signal });
    expect(() => generation.begin()).toThrow("superseded");
    generation.dispose();
  });

  it("reasoning does not protect the request and late text cannot escape after steering", () => {
    const steering = new AbortController();
    const generation = new GenerationSteering({ steeringSignal: steering.signal });
    generation.begin();
    generation.beforeEvent(
      createReasoningAppendedEvent({
        reasoningDelta: "Thinking",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
    );
    steering.abort();
    expect(() =>
      generation.beforeEvent(
        createMessageAppendedEvent({
          messageDelta: "Stale",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        }),
      ),
    ).toThrow("superseded");
    expect(() => generation.protectToolExecution()).toThrow("superseded");
    generation.dispose();
  });

  it.each(["text", "prior text", "tool", "request", "completion", "failure"])(
    "preserves work after %s but still permits explicit cancellation",
    (phase) => {
      const steering = new AbortController();
      const cancellation = new AbortController();
      const generation = new GenerationSteering({
        steeringSignal: steering.signal,
        abortSignal: cancellation.signal,
        outputStarted: phase === "prior text",
      });
      generation.begin();
      if (phase === "text")
        generation.beforeEvent(
          createMessageAppendedEvent({
            messageDelta: "Answer",
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_0",
          }),
        );
      if (phase === "tool") generation.protectToolExecution();
      const coordinates = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
      if (phase === "request")
        generation.beforeEvent(createInputRequestedEvent({ ...coordinates, requests: [] }));
      if (phase === "completion") generation.beforeEvent(createTurnCompletedEvent(coordinates));
      if (phase === "failure")
        generation.beforeEvent(
          createStepFailedEvent({ ...coordinates, code: "MODEL_CALL_FAILED", message: "Failed" }),
        );
      steering.abort();
      expect(generation.signal.aborted).toBe(false);
      cancellation.abort();
      expect(generation.signal.aborted).toBe(true);
      generation.dispose();
    },
  );
});
