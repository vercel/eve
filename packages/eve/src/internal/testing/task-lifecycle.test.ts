import { describe, expect, it } from "vitest";

import {
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createTaskEndedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
} from "#protocol/message.js";

import { taskLifecycleViolations } from "./task-lifecycle.js";

const started = (generation: number, resumable = true) =>
  createTaskStartedEvent({
    callId: `call_${generation}`,
    generation,
    kind: "agent",
    mode: "detached",
    name: "writer",
    parentSessionId: "owner",
    resumable,
    taskId: "writer-1",
    turnId: "turn_1",
  });
const settled = (generation: number, callId = `call_${generation}`) =>
  createTaskSettledEvent({
    callId,
    generation,
    output: "done",
    status: "completed",
    taskId: "writer-1",
  });
const ended = createTaskEndedEvent("writer-1");

describe("taskLifecycleViolations", () => {
  it("accepts generations that each start, settle once, and end once", () => {
    expect(
      taskLifecycleViolations([
        started(1),
        settled(1),
        started(2),
        settled(2),
        ended,
        createSessionCompletedEvent(),
      ]),
    ).toEqual([]);
    expect(taskLifecycleViolations([started(1), settled(1)])).toEqual([]);
  });

  it("reports a settle without its start and a repeated settle", () => {
    expect(taskLifecycleViolations([settled(1), ended])).toEqual([
      "task.settled at event 0 for writer-1: generation 1 has no open task.started",
      "task.ended at event 1 for writer-1: the task never started",
    ]);
    expect(taskLifecycleViolations([started(1), settled(1), settled(1), ended])).toEqual([
      "task.settled at event 2 for writer-1: generation 1 has no open task.started",
    ]);
  });

  it("reports overlapping, skipped, and repeated generations", () => {
    expect(taskLifecycleViolations([started(1), started(2), settled(2), ended])).toEqual([
      "task.started at event 1 for writer-1: generation 1 has not settled",
    ]);
    expect(taskLifecycleViolations([started(1), settled(1), started(3), settled(3)])).toEqual([
      "task.started at event 2 for writer-1: generation 3 follows 1",
    ]);
    expect(taskLifecycleViolations([started(1), started(1), settled(1)])).toEqual([
      "task.started at event 1 for writer-1: generation 1 has not settled",
      "task.started at event 1 for writer-1: generation 1 follows 1",
    ]);
  });

  it("reports an early end, a second end, and events after the end", () => {
    expect(taskLifecycleViolations([started(1), ended, settled(1)])).toEqual([
      "task.ended at event 1 for writer-1: generation 1 has not settled",
      "task.settled at event 2 for writer-1 follows its task.ended",
    ]);
    expect(taskLifecycleViolations([started(1), settled(1), ended, ended])).toEqual([
      "task.ended at event 3 for writer-1 follows its task.ended",
    ]);
  });

  it("reports a second generation of a task that is not resumable", () => {
    expect(
      taskLifecycleViolations([started(1, false), settled(1), started(2, false), settled(2)]),
    ).toEqual([
      "task.started at event 2 for writer-1: a task that is not resumable has one generation",
      "writer-1 is not resumable and did not end when its generation settled",
    ]);
  });

  it("reports a generation that settles for another call than the one that started it", () => {
    expect(taskLifecycleViolations([started(1), settled(1, "call_other"), ended])).toEqual([
      "task.settled at event 1 for writer-1: generation 1 started for call_1 and settled for call_other",
    ]);
  });

  it("reports any task event after the session ended", () => {
    const failed = createSessionFailedEvent({ code: "X", message: "boom", sessionId: "s" });
    expect(taskLifecycleViolations([started(1), settled(1), failed, ended])).toEqual([
      "task.ended at event 3 for writer-1 follows the session's end",
    ]);
    expect(
      taskLifecycleViolations([
        started(1),
        settled(1),
        ended,
        createSessionCompletedEvent(),
        started(2),
      ]),
    ).toEqual([
      "task.started at event 4 for writer-1 follows the session's end",
      "task.started at event 4 for writer-1 follows its task.ended",
    ]);
  });

  it("reports tasks that never end when they must", () => {
    expect(taskLifecycleViolations([started(1, false), settled(1)])).toEqual([
      "writer-1 is not resumable and did not end when its generation settled",
    ]);
    expect(
      taskLifecycleViolations([started(1), settled(1), createSessionCompletedEvent()]),
    ).toEqual(["writer-1 did not end before its session did"]);
  });
});
