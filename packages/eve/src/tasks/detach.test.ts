import { sleep } from "#compiled/@workflow/core/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DetachTimers,
  DISMISSED_CALL_GRACE_MS,
  isSleepToolWorkflowId,
  planTaskWait,
  resolveWaitInterruption,
  steeringInterruptsWait,
  type TaskWaitPlan,
} from "#tasks/detach.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sleep: vi.fn(),
}));

afterEach(() => vi.mocked(sleep).mockReset());

const SLEEP_ID = "workflow//eve@0.66.1//executeSleepTool";

describe("isSleepToolWorkflowId", () => {
  it.each([
    SLEEP_ID,
    "workflow//eve//executeSleepTool",
    "workflow//./src/execution/tools/sleep-workflow//executeSleepTool",
  ])("recognizes eve's sleep tool as %s", (workflowId) => {
    expect(isSleepToolWorkflowId(workflowId)).toBe(true);
  });

  it.each([
    "workflow//./agent/tools/sleep//execute",
    "workflow//./agent/tools/nap//executeSleepTool",
    "workflow//other-package@1.0.0//executeSleepTool",
    "eve//agent-task",
  ])("does not treat %s as eve's sleep tool", (workflowId) => {
    expect(isSleepToolWorkflowId(workflowId)).toBe(false);
  });
});

describe("planTaskWait", () => {
  const requests = [
    { callId: "call-sleep", workflowId: SLEEP_ID },
    { callId: "call-tests", detach: { timeout: 120_000 }, workflowId: "workflow//./t//execute" },
    { callId: "call-deploy", detach: false, workflowId: "workflow//./d//execute" },
    { callId: "call-agent", workflowId: "eve//agent-task" },
  ];

  it("arms timers and detaches only in an interactive root turn", () => {
    expect(planTaskWait({ detachable: true, requests })).toEqual({
      detachable: true,
      sleepCallIds: ["call-sleep"],
      timeouts: [{ callId: "call-tests", timeoutMs: 120_000 }],
    });
  });

  it("keeps the sleep rule but no timers elsewhere", () => {
    const plan = planTaskWait({ detachable: false, requests });
    expect(plan).toEqual({ detachable: false, sleepCallIds: ["call-sleep"], timeouts: [] });
    expect(steeringInterruptsWait(plan)).toBe(true);
    expect(
      steeringInterruptsWait(planTaskWait({ detachable: false, requests: requests.slice(1) })),
    ).toBe(false);
  });
});

describe("resolveWaitInterruption", () => {
  const interactive: TaskWaitPlan = {
    detachable: true,
    sleepCallIds: ["call-sleep"],
    timeouts: [{ callId: "call-tests", timeoutMs: 5_000 }],
  };

  it("ends waited sleeps and detaches every other waited call on steer", () => {
    expect(
      resolveWaitInterruption({
        interruption: { dismissedTaskIds: ["ask_question-a1b2c3"], kind: "steer" },
        plan: interactive,
        unresolvedCallIds: ["call-sleep", "call-d0", "call-ask"],
      }),
    ).toEqual({
      detachCallIds: ["call-d0", "call-ask"],
      endCallIds: ["call-sleep"],
      groupCallId: "call-d0",
      keepTaskIds: ["ask_question-a1b2c3"],
      reason: "steer",
    });
  });

  it("detaches a dismissed call into its message's group when its grace period ends", () => {
    expect(
      resolveWaitInterruption({
        dismissed: new Map([["call-ask", "call-d0"]]),
        interruption: { callId: "call-ask", kind: "timeout" },
        plan: interactive,
        unresolvedCallIds: ["call-ask"],
      }),
    ).toEqual({
      detachCallIds: ["call-ask"],
      endCallIds: [],
      groupCallId: "call-d0",
      keepTaskIds: [],
      reason: "steer",
    });
  });

  it("only ends sleeps on steer outside an interactive root turn", () => {
    const child: TaskWaitPlan = { ...interactive, detachable: false, timeouts: [] };
    expect(
      resolveWaitInterruption({
        interruption: { dismissedTaskIds: [], kind: "steer" },
        plan: child,
        unresolvedCallIds: ["call-sleep", "call-d0"],
      }),
    ).toEqual({ detachCallIds: [], endCallIds: ["call-sleep"], keepTaskIds: [], reason: "steer" });
    expect(
      resolveWaitInterruption({
        interruption: { dismissedTaskIds: [], kind: "steer" },
        plan: child,
        unresolvedCallIds: ["call-d0"],
      }),
    ).toBeUndefined();
  });

  it("detaches only the timer's own call, and nothing once it resolved", () => {
    const interruption = { callId: "call-tests", kind: "timeout" } as const;
    expect(
      resolveWaitInterruption({
        interruption,
        plan: interactive,
        unresolvedCallIds: ["call-tests", "call-d0"],
      }),
    ).toEqual({
      detachCallIds: ["call-tests"],
      endCallIds: [],
      keepTaskIds: [],
      reason: "timeout",
    });
    expect(
      resolveWaitInterruption({ interruption, plan: interactive, unresolvedCallIds: ["call-d0"] }),
    ).toBeUndefined();
  });
});

describe("DetachTimers", () => {
  it("races one durable sleep per timed call and stops racing disarmed calls", async () => {
    const fired = new Map<number, () => void>();
    vi.mocked(sleep).mockImplementation(
      (async (durationMs: number) =>
        await new Promise<void>((resolve) => fired.set(durationMs, resolve))) as typeof sleep,
    );
    const timers = new DetachTimers([
      { callId: "call-slow", timeoutMs: 5_000 },
      { callId: "call-slower", timeoutMs: 9_000 },
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);

    const first = timers.next();
    fired.get(9_000)!();
    await expect(first).resolves.toBe("call-slower");

    timers.disarm(["call-slower", "call-slow"]);
    expect(timers.next()).toBeUndefined();

    timers.arm("call-ask", DISMISSED_CALL_GRACE_MS);
    const grace = timers.next();
    fired.get(DISMISSED_CALL_GRACE_MS)!();
    await expect(grace).resolves.toBe("call-ask");
  });
});
