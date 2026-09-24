import { describe, expect, it } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { createTaskRecord, taskTable, taskTableState } from "#internal/testing/task-records.js";
import {
  applyTaskInputEvent,
  hasPendingTaskInput,
  planTaskAnswers,
  type TaskAnswers,
} from "#tasks/input.js";
import type { TaskInputBatch, TaskInputRequest } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";

function request(requestId: string, overrides: Partial<TaskInputRequest> = {}): TaskInputRequest {
  return {
    action: { callId: "call", input: {}, kind: "tool-call", toolName: "deploy" },
    kind: "question",
    prompt: "Which region?",
    requestId,
    ...overrides,
  };
}

function batch(requests: readonly TaskInputRequest[], sequence = 0): TaskInputBatch {
  return { requests, sequence, stepIndex: 1, turnId: "turn_c" };
}

function requested(requests: readonly TaskInputRequest[], sequence = 0) {
  return {
    data: { requests, sequence, stepIndex: 1, turnId: "turn_c" },
    type: "input.requested" as const,
  };
}

function resolved(...requestIds: string[]) {
  return {
    data: {
      resolutions: requestIds.map((requestId) => ({
        kind: "question" as const,
        outcome: "answered" as const,
        requestId,
      })),
      sequence: 0,
      stepIndex: 1,
      turnId: "turn_c",
    },
    type: "input.resolved" as const,
  };
}

describe("applyTaskInputEvent", () => {
  it("adds a requested batch and removes each request its child resolves", () => {
    const added = applyTaskInputEvent([], requested([request("a"), request("b")]));
    expect(added).toEqual([batch([request("a"), request("b")])]);

    expect(applyTaskInputEvent(added, resolved("a"))).toEqual([batch([request("b")])]);
    expect(applyTaskInputEvent(added, resolved("a", "b"))).toEqual([]);
    expect(applyTaskInputEvent(added, resolved("unknown"))).toEqual(added);
  });

  it("ignores a repeated report of requests it already holds", () => {
    const added = applyTaskInputEvent([], requested([request("a")]));
    expect(applyTaskInputEvent(added, requested([request("a")], 5))).toBe(added);
    expect(applyTaskInputEvent(added, requested([request("a"), request("b")], 5))).toEqual([
      batch([request("a")]),
      batch([request("b")], 5),
    ]);
  });

  it("keeps two grandchildren's batches, asked through one child, side by side", () => {
    // Alice's research agent delegated to two agents, and each asked a question.
    const first = applyTaskInputEvent([], requested([request("billing-q")], 1));
    const both = applyTaskInputEvent(first, requested([request("support-q")], 2));
    expect(both).toEqual([batch([request("billing-q")], 1), batch([request("support-q")], 2)]);

    expect(applyTaskInputEvent(both, resolved("billing-q"))).toEqual([
      batch([request("support-q")], 2),
    ]);
  });
});

const WORKFLOW = { commandToken: "control", kind: "workflow" as const, runId: "run" };
const LOCAL = { continuationToken: "child-token", kind: "local" as const, sessionId: "child" };

function waiting(id: string, requests: readonly TaskInputRequest[], child: TaskRecord["child"]) {
  return createTaskRecord({
    callId: `call-${id}`,
    child,
    id,
    input: [batch(requests)],
    status: "input_required",
  });
}

function plan(records: readonly TaskRecord[], delivery: Omit<DeliverHookPayload, "kind">) {
  return planTaskAnswers({ delivery: { kind: "deliver", ...delivery }, table: taskTable(records) });
}

function routed(answers: readonly TaskAnswers[]) {
  return answers.map(({ dismissed, record, responses }) => ({
    dismissed,
    responses,
    taskId: record.id,
  }));
}

describe("planTaskAnswers", () => {
  it("routes a response to the task waiting on its request and keeps the rest", () => {
    const tasks = [
      waiting("research-aaaaaa", [request("r-1")], LOCAL),
      waiting("deploy-bbbbbb", [request("d-1")], WORKFLOW),
    ];

    const result = plan(tasks, {
      payloads: [
        { inputResponses: [{ requestId: "r-1", text: "eu" }] },
        {
          inputResponses: [
            { requestId: "d-1", optionId: "yes" },
            { requestId: "own", text: "x" },
          ],
        },
        { message: "Thanks." },
      ],
    });

    expect(routed(result.answers)).toEqual([
      { dismissed: [], responses: [{ requestId: "r-1", text: "eu" }], taskId: "research-aaaaaa" },
      {
        dismissed: [],
        responses: [{ optionId: "yes", requestId: "d-1" }],
        taskId: "deploy-bbbbbb",
      },
    ]);
    expect(result.cancelTurn).toBe(false);
    expect(result.remainder?.payloads).toEqual([
      { inputResponses: [{ requestId: "own", text: "x" }] },
      { message: "Thanks." },
    ]);
  });

  it("takes the first answer to a request and drops the repeats", () => {
    const result = plan([waiting("research-aaaaaa", [request("r-1")], LOCAL)], {
      payloads: [
        { inputResponses: [{ requestId: "r-1", text: "first" }] },
        { inputResponses: [{ requestId: "r-1", text: "second" }] },
      ],
    });

    expect(routed(result.answers)[0]?.responses).toEqual([{ requestId: "r-1", text: "first" }]);
    expect(result.remainder).toBeUndefined();
  });

  it("answers the only pending question with a person's plain message", () => {
    const result = plan([waiting("research-aaaaaa", [request("r-1")], LOCAL)], {
      payloads: [{ message: "  eu-west  " }, { message: "Also check the logs." }],
    });

    expect(routed(result.answers)).toEqual([
      {
        dismissed: [],
        responses: [{ requestId: "r-1", text: "eu-west" }],
        taskId: "research-aaaaaa",
      },
    ]);
    // Once answered, the question takes no second message.
    expect(result.remainder?.payloads).toEqual([{ message: "Also check the logs." }]);
  });

  it("dismisses every dismissible question when a message answers none of them", () => {
    const tasks = [
      waiting("deploy-bbbbbb", [request("d-1", { dismissible: true })], WORKFLOW),
      waiting("research-aaaaaa", [request("r-1")], LOCAL),
    ];

    const result = plan(tasks, { payloads: [{ message: "Never mind, use Plain." }] });

    expect(routed(result.answers)).toEqual([
      { dismissed: ["d-1"], responses: [], taskId: "deploy-bbbbbb" },
    ]);
    expect(result.remainder?.payloads).toEqual([{ message: "Never mind, use Plain." }]);
  });

  it("dismisses a dismissible question a message does not resolve", () => {
    const pick = request("d-1", {
      dismissible: true,
      options: [{ id: "yes", label: "Yes" }],
    });

    const result = plan([waiting("deploy-bbbbbb", [pick], WORKFLOW)], {
      payloads: [{ message: "What does this deploy?" }],
    });

    expect(routed(result.answers)).toEqual([
      { dismissed: ["d-1"], responses: [], taskId: "deploy-bbbbbb" },
    ]);
  });

  it("never resolves a delegating caller's message against a question", () => {
    const tasks = [waiting("deploy-bbbbbb", [request("d-1", { dismissible: true })], WORKFLOW)];
    const delivery = {
      caller: { callId: "c", replyTo: { kind: "hook" as const, token: "t" }, subagentName: "a" },
      payloads: [{ message: "eu" }],
    };

    const result = plan(tasks, delivery);

    expect(result.answers).toEqual([]);
    expect(result.remainder).toEqual({ kind: "deliver", ...delivery });
  });

  it("leaves a message alone when an approval, not a question, is pending", () => {
    const approval = request("a-1", { kind: "tool-approval" });

    const result = plan([waiting("research-aaaaaa", [approval], LOCAL)], {
      payloads: [{ message: "approve" }],
    });

    expect(result.answers).toEqual([]);
  });

  it("stops this session's turn when a descendant's session-limit prompt is declined", () => {
    const limit = request("limit-1", { kind: "session-limit" });

    const result = plan([waiting("research-aaaaaa", [limit], LOCAL)], {
      payloads: [{ inputResponses: [{ optionId: "stop", requestId: "limit-1" }] }],
    });

    expect(result.cancelTurn).toBe(true);
    expect(routed(result.answers)[0]?.responses).toEqual([
      { optionId: "stop", requestId: "limit-1" },
    ]);
  });

  it("moves a used-up payload's metadata to the child and reindexes what stays", () => {
    const metadata = (payloadIndex: number) => ({
      channelKind: "slack",
      channelName: "slack",
      deliveryId: `d-${payloadIndex}`,
      payloadIndex,
    });

    // A question with options only: the plain message does not answer it.
    const pick = request("r-1", { options: [{ id: "eu", label: "EU" }] });
    const result = plan([waiting("research-aaaaaa", [pick], LOCAL)], {
      auth: null,
      deliveryMetadata: [metadata(0), metadata(1)],
      payloads: [{ message: "Hello" }, { inputResponses: [{ requestId: "r-1", text: "eu" }] }],
      requestId: "request-1",
    });

    expect(result.answers[0]?.deliveryMetadata).toEqual([{ ...metadata(1), payloadIndex: 0 }]);
    expect(result.remainder).toEqual({
      auth: null,
      deliveryMetadata: [metadata(0)],
      kind: "deliver",
      payloads: [{ message: "Hello" }],
      requestId: "request-1",
    });
  });

  it("passes a delivery through when nothing it holds is for a task", () => {
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "own", text: "x" }] }],
    };

    expect(
      planTaskAnswers({
        delivery,
        table: taskTable([waiting("research-aaaaaa", [request("r-1")], LOCAL)]),
      }),
    ).toEqual({ answers: [], cancelTurn: false, remainder: delivery });
  });
});

it("reports pending task input from the task table alone", () => {
  expect(hasPendingTaskInput({ state: taskTableState([createTaskRecord()]) })).toBe(false);
  expect(
    hasPendingTaskInput({
      state: taskTableState([waiting("research-aaaaaa", [request("r-1")], LOCAL)]),
    }),
  ).toBe(true);
});
