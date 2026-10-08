import { describe, expect, it } from "vitest";
import { beforeStep, afterStep } from "#harness/hitl/reducer.js";
import { LEGACY_PARKING_KEYS } from "#harness/session-machine/migrate-legacy.js";
import { HumanInput } from "#internal/testing/hitl-observer.js";
import type { HumanInputState } from "#harness/session-machine/migrate-legacy.js";
import type { InputRequest } from "#shared/input.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { SessionStateMap } from "#harness/types.js";
import { migrateSessionState } from "./migrate.js";
import { sessionView } from "./commit.js";
import { runtimeWait, storedProjection } from "./view.js";

const at = { sequence: 1, stepIndex: 2, turnId: "turn_1" };
const approval: InputRequest = {
  action: { kind: "tool-call", callId: "deploy-call", toolName: "deploy", input: {} },
  kind: "tool-approval",
  prompt: "Approve deploy?",
  requestId: "deploy",
};
const task: RuntimeWorkflowTaskRequest = {
  kind: "workflow-task",
  callId: "run-call",
  entry: { entryPoint: "execute" },
  input: {},
  toolName: "run",
  workflowId: "run-workflow",
};
function upgrade(state: SessionStateMap) {
  const original: { state: SessionStateMap } = { state: { authored: { keep: true }, ...state } };
  const saved = migrateSessionState(original);
  expect(original.state).toMatchObject(state);
  for (const key of LEGACY_PARKING_KEYS) expect(saved.state?.[key]).toBeUndefined();
  expect(saved.state?.authored).toEqual({ keep: true });
  expect(migrateSessionState(saved)).toBe(saved);
  return sessionView(storedProjection(saved.state), saved.state);
}

describe("machine hydration upgrades", () => {
  it("resumes an approval parked under eve.harness.humanInput", () => {
    const legacy: HumanInputState = {
      grants: [],
      requests: {
        deploy: {
          kind: "tool-approval",
          at,
          request: approval,
          requester: null,
          approvalKey: "deploy",
        },
      },
      held: { at, messages: [] },
    };
    const view = upgrade({ "eve.harness.humanInput": legacy });
    expect(view.turn.suspended[0]?.requests).toEqual([approval]);
    const resumed = beforeStep(view, [
      {
        type: "input.answered",
        now: 0,
        responder: null,
        responses: [{ requestId: "deploy", optionId: "approve" }],
      },
    ]);
    expect(resumed.transition.turn.suspended[0]?.approved).toEqual([approval]);
  });

  it("resumes runtime work parked under eve.runtime.pendingCoordinationBatch", () => {
    const view = upgrade({
      "eve.runtime.pendingCoordinationBatch": {
        event: at,
        tasks: [task],
        responseMessages: [],
        followingInput: { message: "next" },
      },
    });
    expect(runtimeWait({ "eve.harness.turnState": view.turn })?.tasks).toEqual([task]);
    const resumed = afterStep(view, {
      at,
      type: "actions.settled",
      results: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "run-call",
              toolName: "run",
              output: { type: "text", value: "done" },
            },
          ],
        },
      ],
    });
    expect(resumed.transition.turn.suspended).toEqual([]);
    expect(resumed.transition.turn.queued?.message).toBe("next");
  });

  it("retains session grants from eve.runtime.hitl.approvedTools", () => {
    const view = upgrade({ "eve.runtime.hitl.approvedTools": ["deploy"] });
    expect(HumanInput.fromView(view).grantedApprovalKeys()).toEqual(new Set(["deploy"]));
  });

  it("routes a persisted workflow question from eve.runtime.proxyInputRequests", () => {
    const view = upgrade({
      "eve.runtime.proxyInputRequests": {
        ask: {
          event: at,
          kind: "question",
          childContinuationToken: "child",
          runId: "run",
          workflowAsk: { control: "control", question: { allowFreeform: true } },
        },
      },
    });
    const resumed = beforeStep(view, [
      {
        type: "delivery.received",
        responses: [],
        message: { delegated: false, text: "yes" },
      },
    ]);
    expect(resumed.effects).toEqual([
      {
        type: "forwardAnswer",
        route: expect.objectContaining({ control: "control", runId: "run" }),
        responses: [{ requestId: "ask", text: "yes" }],
      },
    ]);
    expect(resumed.transition.turn.hitl?.relayedRoutes).toEqual({});
  });
});

it("refuses to resume malformed legacy coordination checkpoints", () => {
  expect(() =>
    migrateSessionState({ state: { "eve.runtime.pendingCoordinationBatch": { callId: "old" } } }),
  ).toThrow("cannot resume session");
});
