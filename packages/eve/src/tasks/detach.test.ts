import { describe, expect, it } from "vitest";

import {
  isSleepToolWorkflowId,
  planTaskWait,
  resolveWaitInterruption,
  steeringInterruptsWait,
  type TaskWaitPlan,
} from "#tasks/detach.js";

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
    { attached: true, callId: "call-sleep", workflowId: SLEEP_ID },
    { attached: true, callId: "call-lookup", workflowId: "workflow//./l//execute" },
    { attached: false, callId: "call-deploy", workflowId: "workflow//./d//execute" },
    { callId: "call-agent", workflowId: "eve//agent-task" },
  ];

  it("lists waited sleeps and the other attached calls", () => {
    expect(planTaskWait({ detachable: true, requests })).toEqual({
      attachedCallIds: ["call-lookup"],
      detachable: true,
      sleepCallIds: ["call-sleep"],
    });
  });

  it("keeps the sleep rule outside an interactive root turn", () => {
    const plan = planTaskWait({ detachable: false, requests });
    expect(plan).toEqual({
      attachedCallIds: ["call-lookup"],
      detachable: false,
      sleepCallIds: ["call-sleep"],
    });
    expect(steeringInterruptsWait(plan)).toBe(true);
    expect(
      steeringInterruptsWait(planTaskWait({ detachable: false, requests: requests.slice(1) })),
    ).toBe(false);
  });
});

describe("resolveWaitInterruption", () => {
  const interactive: TaskWaitPlan = {
    attachedCallIds: ["call-lookup"],
    detachable: true,
    sleepCallIds: ["call-sleep"],
  };

  it("ends waited sleeps and detaches every other waited call but attached ones on steer", () => {
    expect(
      resolveWaitInterruption({
        interruption: { dismissedTaskIds: ["ask_question-a1b2c3"], kind: "steer" },
        plan: interactive,
        unresolvedCallIds: ["call-sleep", "call-d0", "call-lookup", "call-ask"],
      }),
    ).toEqual({
      detachCallIds: ["call-d0", "call-ask"],
      endCallIds: ["call-sleep"],
      groupCallId: "call-d0",
      keepTaskIds: ["ask_question-a1b2c3"],
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
    });
  });

  it("only ends sleeps on steer outside an interactive root turn", () => {
    const child: TaskWaitPlan = { ...interactive, detachable: false };
    expect(
      resolveWaitInterruption({
        interruption: { dismissedTaskIds: [], kind: "steer" },
        plan: child,
        unresolvedCallIds: ["call-sleep", "call-d0"],
      }),
    ).toEqual({ detachCallIds: [], endCallIds: ["call-sleep"], keepTaskIds: [] });
    expect(
      resolveWaitInterruption({
        interruption: { dismissedTaskIds: [], kind: "steer" },
        plan: child,
        unresolvedCallIds: ["call-d0"],
      }),
    ).toBeUndefined();
  });

  it("detaches nothing for a timer that is not a dismissed call's, or once it resolved", () => {
    const interruption = { callId: "call-ask", kind: "timeout" } as const;
    expect(
      resolveWaitInterruption({ interruption, plan: interactive, unresolvedCallIds: ["call-ask"] }),
    ).toBeUndefined();
    expect(
      resolveWaitInterruption({
        dismissed: new Map([["call-ask", "call-d0"]]),
        interruption,
        plan: interactive,
        unresolvedCallIds: ["call-d0"],
      }),
    ).toBeUndefined();
  });
});
