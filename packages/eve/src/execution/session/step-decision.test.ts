import { describe, expect, it } from "vitest";
import { readStepState } from "#execution/session/step-reading.js";
import type { ModelMessage } from "ai";
import { decideStep, type StepDecision, type StepState } from "#execution/session/step-decision.js";
import { withOpenTurn, withParkedStep, withPublished } from "#internal/testing/session-machine.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { waiting } from "#protocol/session-projection/selectors.js";

const PARTS = [
  "ended",
  "turnOpen",
  "queued",
  "unweighed",
  "requests",
  "signIns",
  "calls",
  "dispatch",
  "unread",
  "tasks",
] as const;
type Parts = Record<(typeof PARTS)[number], boolean>;

/** Every state `decideStep` can tell apart. `dispatch` means something only with `calls`. */
function everyState(): Parts[] {
  const states: Parts[] = [];
  for (let n = 0; n < 2 ** PARTS.length; n++) {
    const parts = Object.fromEntries(
      PARTS.map((part, index) => [part, (n & (1 << (PARTS.length - 1 - index))) !== 0]),
    ) as Parts;
    if (parts.calls || !parts.dispatch) states.push(parts);
  }
  return states;
}

function stepState(parts: Parts): StepState {
  return {
    ended: parts.ended,
    queuedInput: parts.queued,
    requestIds: parts.requests ? ["request_1"] : [],
    signIns: parts.signIns ? [{ attemptId: "attempt_1" }] : [],
    turnOpen: parts.turnOpen,
    unreadInput: parts.unread,
    unweighedAnswers: parts.unweighed,
    workingTaskIds: parts.tasks ? ["task_1"] : [],
    ...(parts.calls && {
      calls: { callIds: ["call_1"], dispatch: parts.dispatch, taskToolCalls: [] },
    }),
  };
}

function render(decision: StepDecision): string {
  switch (decision.kind) {
    case "end":
    case "run":
      return decision.kind;
    case "park":
      return decision.turnOpen === true ? "park open" : "park";
    case "wait":
      return decision.pause.on === "calls" && decision.pause.dispatch
        ? "wait calls dispatch"
        : `wait ${decision.pause.on}`;
  }
}

describe("decideStep, over every state it can tell apart", () => {
  const states = everyState().map((parts) => ({
    decision: decideStep(stepState(parts)),
    parts,
  }));
  const person = (parts: Parts) => parts.requests || parts.signIns;
  const input = (parts: Parts) => parts.queued || parts.unweighed || parts.unread;
  const failing = (holds: (parts: Parts, decision: StepDecision) => boolean) =>
    states.flatMap(({ decision, parts }) =>
      holds(parts, decision)
        ? []
        : [`${PARTS.filter((part) => parts[part]).join(" ") || "nothing"} -> ${render(decision)}`],
    );

  it("waits only on something that can end the wait", () => {
    expect(
      failing((parts, decision) => {
        if (decision.kind !== "wait") return true;
        switch (decision.pause.on) {
          case "interaction":
            return person(parts);
          case "calls":
            return parts.calls && decision.pause.dispatch === parts.dispatch;
          case "tasks":
            return parts.tasks;
        }
      }),
    ).toEqual([]);
  });

  it("ends exactly when the session ended, and runs or waits only in an open turn", () => {
    expect(failing((parts, decision) => (decision.kind === "end") === parts.ended)).toEqual([]);
    expect(
      failing(
        (parts, decision) =>
          (decision.kind !== "run" && decision.kind !== "wait") || (parts.turnOpen && !parts.ended),
      ),
    ).toEqual([]);
  });

  it("runs only on input the next step takes: answers to weigh, or input past every wait", () => {
    const takes = (parts: Parts) =>
      parts.unweighed || (!person(parts) && !parts.calls && (parts.queued || parts.unread));
    expect(
      failing(
        (parts, decision) =>
          (decision.kind === "run") === (parts.turnOpen && !parts.ended && takes(parts)),
      ),
    ).toEqual([]);
    expect(failing((parts, decision) => decision.kind !== "run" || input(parts))).toEqual([]);
  });

  // Input a turn holds arrived before what it waits on, and no step takes it until the wait
  // ends: a run would take nothing, and the turn would spin.
  it("keeps input the turn holds waiting behind a person or calls", () => {
    expect(
      failing(
        (parts, decision) =>
          !(parts.turnOpen && !parts.ended && !parts.unweighed && (person(parts) || parts.calls)) ||
          decision.kind === "wait",
      ),
    ).toEqual([]);
  });

  it("parks a turn open only when nothing can wake it, which the check flags", () => {
    expect(
      failing(
        (parts, decision) =>
          (decision.kind === "park" && decision.turnOpen === true) ===
          (parts.turnOpen &&
            !parts.ended &&
            !input(parts) &&
            !person(parts) &&
            !parts.calls &&
            !parts.tasks),
      ),
    ).toEqual([]);
  });

  it("decides a wait from what it waits on, whatever lies below it", () => {
    const below: Record<"interaction" | "calls" | "tasks", readonly (typeof PARTS)[number][]> = {
      calls: ["unread", "queued", "tasks"],
      interaction: ["calls", "dispatch", "unread", "queued", "tasks"],
      tasks: [],
    };
    expect(
      failing((parts, decision) => {
        if (decision.kind !== "wait") return true;
        return below[decision.pause.on].every((part) => {
          const changed = { ...parts, [part]: !parts[part] };
          if (!changed.calls && changed.dispatch) return true;
          return render(decideStep(stepState(changed))) === render(decision);
        });
      }),
    ).toEqual([]);
  });
});

describe("readStepState", () => {
  const session: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [],
    sessionId: "test-session",
  };
  const waitCall: ModelMessage = {
    content: [
      { input: {}, toolCallId: "wait-call", toolName: TASK_WAIT_TOOL_NAME, type: "tool-call" },
    ],
    role: "assistant",
  };
  const deployRun: RuntimeWorkflowTaskRequest = {
    callId: "deploy-call",
    entry: { entryPoint: "execute" },
    input: { service: "api" },
    kind: "workflow-task",
    toolName: "deploy",
    workflowId: "workflow//./agent/tools/deploy//execute",
  };
  const parked = (tasks: readonly RuntimeWorkflowTaskRequest[]) =>
    withParkedStep(session, {
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      messages: [waitCall],
      tasks,
    });

  it.each([
    { name: "a local answer", forwarded: false, signIn: false, completed: false, ready: true },
    { name: "a forwarded answer", forwarded: true, signIn: false, completed: false, ready: false },
    {
      name: "a responder awaiting sign-in",
      forwarded: false,
      signIn: true,
      completed: false,
      ready: false,
    },
    { name: "a responder signed in", forwarded: false, signIn: true, completed: true, ready: true },
  ])(
    "samples whether $name can be weighed by this session",
    ({ forwarded, signIn, completed, ready }) => {
      let answering = withPublished(withOpenTurn(session, { sequence: 0, turnId: "turn_0" }), [
        {
          type: "interaction.opened",
          data: {
            interactionId: "approval",
            subject: { turnId: "turn_0" },
            request: { kind: "approval", prompt: "Approve Alice's release?" },
            ...(forwarded && { origin: { interactionId: "child-approval", sessionId: "child" } }),
          },
        },
        { type: "delivery.admitted", data: { deliveryId: "answer" } },
        {
          type: "response.submitted",
          data: {
            interactionId: "approval",
            responseId: "response",
            deliveryId: "answer",
            value: { optionId: "approve" },
          },
        },
      ]);
      if (signIn) {
        answering = withPublished(answering, [
          {
            type: "interaction.opened",
            data: {
              interactionId: "sign-in",
              subject: { responseId: "response" },
              request: {
                kind: "sign-in",
                prompt: "Sign in to approve",
                signIn: { name: "github" },
              },
            },
          },
        ]);
        if (completed) {
          answering = withPublished(answering, [
            {
              type: "interaction.settled",
              data: { interactionId: "sign-in", outcome: "accepted" },
            },
          ]);
        }
      }
      expect(readStepState(answering).unweighedAnswers).toBe(ready);
      if (signIn) {
        expect(waiting(storedProjection(answering.state).view, "turn_0")?.on).toBe(
          completed ? "session" : "interaction",
        );
      }
      if (ready) {
        for (const settlement of [
          { type: "response.admitted", data: { responseId: "response" } },
          { type: "response.settled", data: { responseId: "response", outcome: "refused" } },
        ] as const) {
          expect(readStepState(withPublished(answering, [settlement])).unweighedAnswers).toBe(
            false,
          );
        }
      }
    },
  );

  it("waits on a task tool call without dispatching anything", () => {
    expect(readStepState(parked([])).calls).toMatchObject({
      callIds: ["wait-call"],
      dispatch: false,
    });
  });

  it("dispatches the workflow tool runs a batch holds beside its task tool calls", () => {
    expect(readStepState(parked([deployRun])).calls).toMatchObject({
      callIds: ["deploy-call", "wait-call"],
      dispatch: true,
    });
  });

  it("dispatches nothing once each run has started", () => {
    const runId = "test_turn_0_0";
    const started = withPublished(parked([deployRun]), [
      {
        data: {
          callId: "deploy-call",
          capability: { kind: "tool", name: "deploy" },
          owner: { runId },
        },
        scope: { runId, turnId: "turn_0" },
        type: "call.requested",
      },
      { data: { callId: "deploy-call" }, scope: { runId, turnId: "turn_0" }, type: "call.started" },
    ]);
    expect(readStepState(started).calls).toMatchObject({ dispatch: false });
  });
});

describe("resolveSessionStepResult", () => {
  it("refuses a step that says the session ended when its state says it didn't", () => {
    const session: HarnessSession = {
      agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:test-session",
      history: [],
      sessionId: "test-session",
    };

    expect(() =>
      resolveSessionStepResult({ ended: { output: "Alice's report" }, session }, {}),
    ).toThrow("without ending the session");
  });
});
