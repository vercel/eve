import { describe, expect, it } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { createTaskRecord, taskTable, taskTableState } from "#internal/testing/task-records.js";
import type { InputRequestedStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";
import {
  admitTaskInputEvent,
  applyTaskInputEvent,
  hasOwnPendingInput,
  hasPendingTaskInput,
  planTaskAnswers,
  sentAnswerResolutions,
  taskInputResolutions,
  withdrawnTaskInput,
  type TaskAnswers,
  type TaskInputPublication,
} from "#tasks/input.js";
import type { TaskInputBatch, TaskInputEvent, TaskInputRequest } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { applyTaskMessage, cancelTask, findTask, type TaskTable } from "#tasks/table.js";
import { timeOutTask } from "#tasks/table-deadlines.js";

const NOW = "2026-09-24T14:00:00.000Z";

/** The projection a task record keeps of a request. */
function request(requestId: string, overrides: Partial<TaskInputRequest> = {}): TaskInputRequest {
  return { kind: "question", requestId, ...overrides };
}

/** The request as a child's stream carries it. */
function asked(stored: TaskInputRequest): InputRequest & TaskInputRequest {
  return {
    action: { callId: "call", input: { region: "secret" }, kind: "tool-call", toolName: "deploy" },
    prompt: "Which region?",
    ...stored,
  };
}

function batch(requests: readonly TaskInputRequest[], sequence = 0): TaskInputBatch {
  return { requests, sequence, stepIndex: 1, turnId: "turn_c" };
}

function requested(requests: readonly TaskInputRequest[], sequence = 0, taskId?: string) {
  const data: InputRequestedStreamEvent["data"] = {
    requests: requests.map(asked),
    sequence,
    stepIndex: 1,
    turnId: "turn_c",
  };
  if (taskId !== undefined) data.taskId = taskId;
  return { data, type: "input.requested" as const };
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

function ignored(requestIds: readonly string[], sequence = 0): TaskInputEvent {
  return {
    data: {
      resolutions: requestIds.map((requestId) => ({
        kind: "question",
        outcome: "ignored",
        requestId,
      })),
      sequence,
      stepIndex: 1,
      turnId: "turn_c",
    },
    type: "input.resolved",
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

  it("keeps only what routes an answer, not the prompt or the tool call's arguments", () => {
    const pick = request("a", {
      allowFreeform: false,
      dismissible: true,
      options: [{ id: "eu", label: "EU" }],
    });

    const [stored] = applyTaskInputEvent([], requested([pick]));

    expect(stored?.requests).toEqual([pick]);
    expect(JSON.stringify(stored)).not.toContain("secret");
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
    const first = applyTaskInputEvent([], requested([request("billing-q")], 0, "billing-aaaaaa"));
    const both = applyTaskInputEvent(first, requested([request("support-q")], 0, "support-bbbbbb"));
    expect(both).toEqual([
      { ...batch([request("billing-q")]), from: "billing-aaaaaa" },
      { ...batch([request("support-q")]), from: "support-bbbbbb" },
    ]);

    expect(applyTaskInputEvent(both, resolved("billing-q"))).toEqual([
      { ...batch([request("support-q")]), from: "support-bbbbbb" },
    ]);
  });
});

const WORKFLOW = { commandToken: "control", kind: "workflow" as const, runId: "run" };
const LOCAL = { continuationToken: "child-token", kind: "local" as const, sessionId: "child" };

function waiting(
  id: string,
  requests: readonly TaskInputRequest[],
  child: TaskRecord["child"],
  overrides: Partial<TaskRecord> = {},
) {
  return createTaskRecord({
    callId: `call-${id}`,
    child,
    clockStoppedAt: NOW,
    id,
    input: [batch(requests)],
    kind: child?.kind === "workflow" ? "workflow" : "agent",
    status: "input_required",
    ...overrides,
  });
}

/** Records each publication the way the owner does. */
function record(table: TaskTable, publications: readonly TaskInputPublication[]): TaskTable {
  return publications.reduce((current, { event, taskId }) => {
    const task = findTask(current, taskId)!;
    if (event.type !== "input.requested" && event.type !== "input.resolved") return current;
    const input = applyTaskInputEvent(task.input ?? [], event);
    const message = { generation: task.generation, input, kind: "task.input" as const, taskId };
    return applyTaskMessage(current, message, NOW).table;
  }, table);
}

describe("withdrawnTaskInput", () => {
  const research = waiting("research-aaaaaa", [request("r-1"), request("a-1")], LOCAL, {
    deadlineAt: "2026-09-24T15:00:00.000Z",
  });
  const deploy = waiting("deploy-bbbbbb", [request("d-1")], WORKFLOW);
  const before = taskTable([research, deploy]);

  it.each([
    ["cancels", cancelTask(before, research.id, NOW).table],
    ["times out", timeOutTask(before, research.id, NOW).table],
    [
      "settles, like a child that finished past its approval",
      applyTaskMessage(
        before,
        {
          generation: 1,
          kind: "task.settled",
          outcome: { output: "done", status: "completed" },
          taskId: research.id,
        },
        NOW,
      ).table,
    ],
  ])("withdraws every request of a task the owner %s", (_label, after) => {
    expect(taskInputResolutions(withdrawnTaskInput(before, after))).toEqual([
      { event: ignored(["r-1", "a-1"]), taskId: research.id },
    ]);
  });

  it("withdraws a workflow run's open question when its run ends", () => {
    const after = applyTaskMessage(
      before,
      { generation: 1, kind: "task.settled", outcome: { status: "cancelled" }, taskId: deploy.id },
      NOW,
    ).table;

    expect(taskInputResolutions(withdrawnTaskInput(before, after))).toEqual([
      { event: ignored(["d-1"]), taskId: deploy.id },
    ]);
  });

  it("withdraws nothing a task still waits on", () => {
    expect(withdrawnTaskInput(before, before)).toEqual([]);
  });
});

describe("admitTaskInputEvent", () => {
  const research = waiting("research-aaaaaa", [request("r-1")], LOCAL);
  const billing = waiting("billing-cccccc", [request("b-1")], LOCAL);
  const table = taskTable([research, billing]);
  const admit = (event: TaskInputEvent, sessionPending: readonly string[] = []) =>
    admitTaskInputEvent({
      event,
      record: research,
      sessionPending: new Set(sessionPending),
      table,
    });

  it("keeps only the resolutions of requests its own task waits on", () => {
    // Bob's billing agent cannot clear Alice's research question, nor the session's own approval.
    expect(admit(resolved("b-1", "own-approval"))).toEqual({ events: [], refused: [] });
    expect(admit(resolved("r-1", "b-1")).events).toEqual([resolved("r-1")]);
  });

  it("refuses requested IDs another task or the session already waits on, and drops repeats", () => {
    const result = admit(
      requested([request("b-1"), request("own"), request("r-1"), request("r-2")], 3),
      ["own"],
    );

    expect(result).toEqual({
      events: [requested([request("r-2")], 3)],
      refused: ["b-1", "own"],
    });
    expect(admit(requested([request("r-1")], 3))).toEqual({ events: [], refused: [] });
  });

  it("withdraws the batch a retried child step asked first, at the same coordinates", () => {
    const result = admit(requested([request("r-2")]));

    expect(result.events).toEqual([ignored(["r-1"]), requested([request("r-2")])]);
    expect(
      findTask(
        record(
          table,
          result.events.map((event) => ({ event, taskId: research.id })),
        ),
        research.id,
      )?.input,
    ).toEqual([batch([request("r-2")])]);
  });

  it("keeps a batch at the same coordinates that came from a descendant or a workflow run", () => {
    // A grandchild's session numbers its turns like the child's own.
    const forwarded = admit(requested([request("g-1")], 0, "grandchild-dddddd"));
    expect(forwarded.events).toEqual([requested([request("g-1")], 0, "grandchild-dddddd")]);

    const deploy = waiting("deploy-bbbbbb", [request("d-1")], WORKFLOW);
    const second = admitTaskInputEvent({
      event: requested([request("d-2")]),
      record: deploy,
      sessionPending: new Set(),
      table: taskTable([deploy]),
    });
    expect(second.events).toEqual([requested([request("d-2")])]);
  });

  it("keeps every batch a remote child surfaces for its own tasks at shared coordinates", () => {
    // Alice's remote research agent fans out: its billing and support agents ask in their first
    // step, and its deploy workflow asks twice from one call, all at the same coordinates.
    const REMOTE = {
      callbackBaseUrl: "https://a",
      kind: "remote" as const,
      sessionId: "r",
      url: "u",
    };
    let remote = waiting("research-aaaaaa", [request("own-1")], REMOTE);
    const asks = [
      requested([request("billing-q")], 0, "billing-bbbbbb"),
      requested([request("support-q")], 0, "support-cccccc"),
      requested([request("deploy-q1")], 0, "deploy-dddddd"),
      requested([request("deploy-q2")], 0, "deploy-dddddd"),
    ];
    for (const event of asks) {
      const admitted = admitTaskInputEvent({
        event,
        record: remote,
        sessionPending: new Set(),
        table: taskTable([remote]),
      });
      expect(admitted).toEqual({ events: [event], refused: [] });
      const table = record(taskTable([remote]), [{ event, taskId: remote.id }]);
      remote = findTask(table, remote.id)!;
    }

    expect(remote.input?.flatMap((batch) => batch.requests.map((r) => r.requestId))).toEqual([
      "own-1",
      "billing-q",
      "support-q",
      "deploy-q1",
      "deploy-q2",
    ]);
  });

  it("passes other input events through", () => {
    const event: TaskInputEvent = {
      data: { description: "Sign in", name: "linear", sequence: 0, stepIndex: 0, turnId: "t" },
      type: "authorization.required",
    };
    expect(admit(event)).toEqual({ events: [event], refused: [] });
  });
});

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

describe("sentAnswerResolutions", () => {
  it("retires a sent question, so neither a second message nor a second answer reaches it", () => {
    const research = waiting("research-aaaaaa", [request("r-1")], LOCAL, {
      deadlineAt: "2026-09-24T15:00:00.000Z",
    });
    const first = plan([research], { payloads: [{ message: "eu-west" }] });
    const resolutions = sentAnswerResolutions(first.answers[0]!);

    expect(resolutions).toEqual([
      {
        event: {
          data: {
            resolutions: [
              {
                kind: "question",
                outcome: "answered",
                requestId: "r-1",
                response: { requestId: "r-1", text: "eu-west" },
              },
            ],
            sequence: 0,
            stepIndex: 1,
            turnId: "turn_c",
          },
          type: "input.resolved",
        },
        taskId: research.id,
      },
    ]);
    const table = record(taskTable([research]), resolutions);
    expect(findTask(table, research.id)).toMatchObject({ status: "working" });
    expect(findTask(table, research.id)).not.toHaveProperty("clockStoppedAt");

    const message: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Also check the logs." }],
    };
    expect(planTaskAnswers({ delivery: message, table }).remainder).toEqual(message);
    const repeat: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "r-1", text: "us-east" }] }],
    };
    expect(planTaskAnswers({ delivery: repeat, table }).remainder).toEqual(repeat);
  });

  it("keeps an approval until the child resolves it, since its policy may refuse the responder", () => {
    const research = waiting(
      "research-aaaaaa",
      [request("a-1", { kind: "tool-approval" }), request("r-1")],
      LOCAL,
    );
    const answers = plan([research], {
      payloads: [
        {
          inputResponses: [
            { optionId: "approve", requestId: "a-1" },
            { requestId: "r-1", text: "eu" },
          ],
        },
      ],
    }).answers;

    const resolutions = sentAnswerResolutions(answers[0]!);

    expect(resolutions.map(({ event }) => event.data)).toEqual([
      expect.objectContaining({ resolutions: [expect.objectContaining({ requestId: "r-1" })] }),
    ]);
    expect(findTask(record(taskTable([research]), resolutions), research.id)?.input).toEqual([
      batch([request("a-1", { kind: "tool-approval" })]),
    ]);
  });

  it("keeps a descendant's question until the child resolves it for the session that asked", () => {
    // Alice's research agent passes her answer on to its billing agent, which asked.
    const research = waiting("research-aaaaaa", [], LOCAL, {
      input: [{ ...batch([request("b-1")]), from: "billing-bbbbbb" }],
    });
    const answers = plan([research], { payloads: [{ message: "eu-west" }] }).answers;

    expect(answers[0]?.responses).toEqual([{ requestId: "b-1", text: "eu-west" }]);
    expect(sentAnswerResolutions(answers[0]!)).toEqual([]);
  });

  it("ignores a dismissed workflow question", () => {
    const pick = request("d-1", { dismissible: true, options: [{ id: "yes", label: "Yes" }] });
    const deploy = waiting("deploy-bbbbbb", [pick], WORKFLOW);
    const answers = plan([deploy], { payloads: [{ message: "What does this deploy?" }] }).answers;

    expect(sentAnswerResolutions(answers[0]!)).toEqual([
      { event: ignored(["d-1"]), taskId: deploy.id },
    ]);
  });
});

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

  it("leaves a person's text to the session's own pending approval", () => {
    // Alice's agent waits on her approval while its research task asks a free-text question.
    const delivery: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "approve" }] };
    const research = [waiting("research-aaaaaa", [request("r-1")], LOCAL)];
    const deploy = [waiting("deploy-bbbbbb", [request("d-1", { dismissible: true })], WORKFLOW)];
    const withOwn = (records: readonly TaskRecord[]) =>
      planTaskAnswers({ delivery, sessionAsks: true, table: taskTable(records) });

    expect(plan(research, delivery).answers).toHaveLength(1);
    expect(withOwn(research)).toEqual({ answers: [], cancelTurn: false, remainder: delivery });
    // The text still moves past a dismissible question it did not answer.
    expect(routed(withOwn(deploy).answers)).toEqual([
      { dismissed: ["d-1"], responses: [], taskId: "deploy-bbbbbb" },
    ]);
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

it("reads the session's own pending input batches, including a legacy singleton", () => {
  expect(hasOwnPendingInput(undefined)).toBe(false);
  expect(hasOwnPendingInput({ "eve.runtime.pendingInputBatches": [] })).toBe(false);
  expect(hasOwnPendingInput({ "eve.runtime.pendingInputBatches": [{ requests: [] }] })).toBe(true);
  expect(hasOwnPendingInput({ "eve.runtime.pendingInputBatch": { requests: [] } })).toBe(true);
});

it("reports pending task input from the task table alone", () => {
  expect(hasPendingTaskInput({ state: taskTableState([createTaskRecord()]) })).toBe(false);
  expect(
    hasPendingTaskInput({
      state: taskTableState([waiting("research-aaaaaa", [request("r-1")], LOCAL)]),
    }),
  ).toBe(true);
});
