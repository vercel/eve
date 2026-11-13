import type { SessionEvent, SessionStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import {
  didCompleteWorker,
  didFinishWorker,
  measureWorkerTask,
  terminalWorkerMessage,
} from "@evals/browser/worker-events";

function stream(
  facts: readonly SessionEvent[],
  at = "2026-08-27T18:00:00.000Z"
): SessionStreamEvent[] {
  return facts.map((fact, line) => ({
    ...fact,
    meta: { at, position: { index: 0, line } },
  }));
}

const workerRequested = {
  data: {
    callId: "call_worker",
    capability: { kind: "tool", name: "run_browser" },
    input: { message: "Find the showtimes." },
    owner: { runId: "run_0" },
  },
  scope: { turnId: "turn_0" },
  type: "call.requested",
} satisfies SessionEvent;

const workerStarted = {
  data: { callId: "call_worker", taskId: "task_worker" },
  scope: { turnId: "turn_0" },
  type: "call.started",
} satisfies SessionEvent;

function workerSettled(output: {
  readonly message: string;
  readonly status: "failure" | "success";
}) {
  return {
    data: {
      callId: "call_worker",
      outcome: "completed",
      output: { images: [], ...output },
    },
    scope: { taskId: "task_worker" },
    type: "call.settled",
  } satisfies SessionEvent;
}

describe("browser benchmark event detection", () => {
  it("reads the structured result from an attached worker session", () => {
    const completion = stream([
      {
        data: {
          kind: "result",
          partId: "part_result",
          phase: "reply",
          runId: "run_0",
          value: {
            images: [],
            message: "Browser assignment completed.",
            status: "success",
          },
        },
        scope: { turnId: "turn_0" },
        type: "content.completed",
      },
    ]);

    expect(didCompleteWorker(completion)).toBe(true);
    expect(terminalWorkerMessage(undefined, completion)).toBe(
      "Browser assignment completed."
    );
  });

  it("waits for a background worker's run_browser call to settle", () => {
    const initialTurn = stream([workerRequested, workerStarted]);
    const terminal = stream(
      [
        workerRequested,
        workerStarted,
        workerSettled({
          message: "Browser assignment completed.",
          status: "success",
        }),
      ],
      "2026-08-27T18:00:05.000Z"
    );

    expect(didFinishWorker(initialTurn)).toBe(false);
    expect(didCompleteWorker(initialTurn)).toBe(false);
    expect(didCompleteWorker(terminal)).toBe(true);
  });

  it("treats a structured worker failure as terminal but unsuccessful", () => {
    const events = stream([
      workerRequested,
      workerStarted,
      workerSettled({
        message: "Browser assignment failed.",
        status: "failure",
      }),
    ]);

    expect(didFinishWorker(events)).toBe(true);
    expect(didCompleteWorker(events)).toBe(false);
  });

  it.each([
    {
      data: {
        callId: "call_worker",
        error: { code: "WORKER_FAILED", message: "Worker failed." },
        outcome: "failed",
      },
      type: "call.settled",
    },
    {
      data: { outcome: "cancelled", taskId: "task_worker" },
      type: "task.ended",
    },
  ] satisfies SessionEvent[])(
    "treats a $type $data.outcome worker as terminal",
    (terminal) => {
      const initialTurn = stream([workerRequested, workerStarted]);
      const events = stream([workerRequested, workerStarted, terminal]);

      expect(didFinishWorker(initialTurn)).toBe(false);
      expect(didFinishWorker(events)).toBe(true);
      expect(didCompleteWorker(events)).toBe(false);
    }
  );

  it("measures worker duration and model usage from v27 events", () => {
    const events = [
      ...stream([
        {
          data: {
            deliveryId: "delivery_0",
            parts: [{ kind: "text", text: "Find the showtimes." }],
            turnId: "turn_0",
          },
          type: "delivery.consumed",
        },
        {
          data: {
            kind: "model",
            owner: { runId: "run_0" },
            usage: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsd: 0.25,
              inputTokens: 100,
              outputTokens: 20,
            },
          },
          type: "usage.recorded",
        },
        workerRequested,
        workerStarted,
      ]),
      ...stream(
        [
          workerSettled({
            message: "Browser assignment completed.",
            status: "success",
          }),
        ],
        "2026-08-27T18:00:30.000Z"
      ),
    ];

    expect(measureWorkerTask(events, 0)).toEqual({
      costComplete: true,
      costUsd: 0.25,
      durationMs: 30_000,
      inputTokens: 100,
      modelSteps: 1,
      outputTokens: 20,
    });
  });
});
