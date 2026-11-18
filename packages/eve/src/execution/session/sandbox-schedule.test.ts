import { describe, expect, it } from "vitest";

import {
  planSandboxCheck,
  sandboxCheckStarted,
  sandboxTurnStarted,
  type SandboxCheckPlan,
  type SandboxSchedule,
} from "#execution/session/sandbox-schedule.js";
import type { SandboxRunning } from "#sandbox/state.js";

const MINUTE = 60_000;

function marker(idleTimeoutMs: number, ...untils: number[]): SandboxRunning {
  return untils.length === 0
    ? { idleTimeoutMs }
    : { idleTimeoutMs, keepRunning: untils.map((until) => ({ until, while: "true" })) };
}

type Step =
  | {
      readonly now: number;
      readonly idle: boolean;
      readonly running: SandboxRunning;
      readonly check: SandboxCheckPlan | undefined;
      readonly starts?: true;
    }
  | "turn";

function run(steps: readonly Step[]): void {
  let schedule: SandboxSchedule = {};
  steps.forEach((step, index) => {
    if (step === "turn") {
      schedule = sandboxTurnStarted(schedule);
      return;
    }
    const plan = planSandboxCheck(schedule, step);
    expect(plan.check, `step ${index}`).toEqual(step.check);
    schedule = plan.schedule;
    if (step.starts === true && plan.check !== undefined)
      schedule = sandboxCheckStarted(schedule, plan.check);
  });
}

describe("planSandboxCheck", () => {
  const plain = marker(5 * MINUTE);
  const keptHour = marker(0, 60 * MINUTE);
  const keptWithWindow = marker(20 * MINUTE, 60 * MINUTE);

  it.each<{ readonly name: string; readonly steps: readonly Step[] }>([
    {
      name: "stops once at the end of the idle window with no record, never retries, and opens a new window after a turn",
      steps: [
        { now: 0, idle: true, running: plain, check: { at: 5 * MINUTE, stop: true } },
        {
          now: MINUTE,
          idle: true,
          running: plain,
          check: { at: 5 * MINUTE, stop: true },
          starts: true,
        },
        { now: 5 * MINUTE, idle: true, running: plain, check: undefined },
        "turn",
        { now: 10 * MINUTE, idle: true, running: plain, check: { at: 15 * MINUTE, stop: true } },
      ],
    },
    {
      name: "checks at once with idleTimeoutMs 0 while a record is in effect, then every 5 minutes",
      steps: [
        { now: 0, idle: true, running: keptHour, check: { at: 0, stop: true }, starts: true },
        {
          now: 0,
          idle: true,
          running: keptHour,
          check: { at: 5 * MINUTE, stop: true },
          starts: true,
        },
        { now: 5 * MINUTE, idle: true, running: keptHour, check: { at: 10 * MINUTE, stop: true } },
      ],
    },
    {
      name: "checks every 5 minutes inside a long idle window without stopping, and stops only once it ends",
      steps: [
        {
          now: 0,
          idle: true,
          running: keptWithWindow,
          check: { at: 5 * MINUTE, stop: false },
          starts: true,
        },
        {
          now: 5 * MINUTE,
          idle: true,
          running: keptWithWindow,
          check: { at: 10 * MINUTE, stop: false },
          starts: true,
        },
        {
          now: 10 * MINUTE,
          idle: true,
          running: keptWithWindow,
          check: { at: 15 * MINUTE, stop: false },
          starts: true,
        },
        {
          now: 15 * MINUTE,
          idle: true,
          running: keptWithWindow,
          check: { at: 20 * MINUTE, stop: true },
        },
      ],
    },
    {
      name: "checks every 5 minutes during a waiting turn, never stops, and stops checking once nothing is in effect",
      steps: [
        {
          now: 0,
          idle: false,
          running: keptHour,
          check: { at: 5 * MINUTE, stop: false },
          starts: true,
        },
        {
          now: 5 * MINUTE,
          idle: false,
          running: keptHour,
          check: { at: 10 * MINUTE, stop: false },
          starts: true,
        },
        { now: 61 * MINUTE, idle: false, running: keptHour, check: undefined },
      ],
    },
    {
      name: "stops at the moment the last record's time is up when idle, retries a failed stop only while a record is in effect, and never after",
      steps: [
        {
          now: 0,
          idle: true,
          running: marker(0, 7 * MINUTE),
          check: { at: 0, stop: true },
          starts: true,
        },
        {
          now: 0,
          idle: true,
          running: marker(0, 7 * MINUTE),
          check: { at: 5 * MINUTE, stop: true },
          starts: true,
        },
        {
          now: 5 * MINUTE,
          idle: true,
          running: marker(0, 7 * MINUTE),
          check: { at: 7 * MINUTE, stop: true },
          starts: true,
        },
        { now: 7 * MINUTE, idle: true, running: marker(0, 7 * MINUTE), check: undefined },
        "turn",
        {
          now: 9 * MINUTE,
          idle: true,
          running: marker(0, 7 * MINUTE),
          check: { at: 9 * MINUTE, stop: true },
        },
      ],
    },
    {
      name: "checks at the moment the last record's time is up during a turn, without stopping",
      steps: [
        {
          now: 0,
          idle: false,
          running: marker(0, 7 * MINUTE),
          check: { at: 5 * MINUTE, stop: false },
          starts: true,
        },
        {
          now: 5 * MINUTE,
          idle: false,
          running: marker(0, 7 * MINUTE),
          check: { at: 7 * MINUTE, stop: false },
          starts: true,
        },
        { now: 7 * MINUTE, idle: false, running: marker(0, 7 * MINUTE), check: undefined },
      ],
    },
    {
      name: "keeps the next check's time across a turn",
      steps: [
        {
          now: 0,
          idle: true,
          running: keptWithWindow,
          check: { at: 5 * MINUTE, stop: false },
          starts: true,
        },
        {
          now: 5 * MINUTE,
          idle: true,
          running: keptWithWindow,
          check: { at: 10 * MINUTE, stop: false },
        },
        "turn",
        {
          now: 7 * MINUTE,
          idle: false,
          running: keptWithWindow,
          check: { at: 10 * MINUTE, stop: false },
        },
      ],
    },
    {
      name: "moves a check minutes away to now when the session goes idle with idleTimeoutMs 0",
      steps: [
        "turn",
        { now: 0, idle: false, running: keptHour, check: { at: 5 * MINUTE, stop: false } },
        { now: 2 * MINUTE, idle: true, running: keptHour, check: { at: 2 * MINUTE, stop: true } },
      ],
    },
    {
      name: "still stops after a stopping check kept a record that ended a millisecond later, and does not retry that stop",
      steps: [
        { now: 0, idle: true, running: marker(0, 1), check: { at: 0, stop: true }, starts: true },
        { now: 1, idle: true, running: marker(0, 1), check: { at: 1, stop: true }, starts: true },
        { now: 2, idle: true, running: marker(0, 1), check: undefined },
      ],
    },
    {
      name: "plans a stop after a check-only step when the session goes idle with nothing in effect",
      steps: [
        {
          now: 0,
          idle: false,
          running: marker(0, 3 * MINUTE),
          check: { at: 3 * MINUTE, stop: false },
          starts: true,
        },
        {
          now: 3 * MINUTE,
          idle: true,
          running: marker(0, 3 * MINUTE),
          check: { at: 3 * MINUTE, stop: true },
        },
      ],
    },
  ])("$name", ({ steps }) => {
    run(steps);
  });
});
