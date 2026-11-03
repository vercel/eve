import { expect, it } from "vitest";
import { awaitingInput, calledTool, toolOrder } from "#evals/assertions/run.js";
import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import { stampTestEvents, testTurnFacts } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { InteractionKind } from "#protocol/session-events/families/interaction.js";
import type { RequestStatus } from "#protocol/session-projection/request-status.js";

it("orders task controls and agent calls consistently with named tool assertions, excluding skills", async () => {
  const requests = (
    [
      ["lookup", "tool"],
      ["guide", "skill"],
      ["eve__task_wait", "control"],
      ["worker", "agent"],
    ] as const
  ).map(([name, kind]): SessionEvent => ({
    type: "call.requested",
    scope: { turnId: "turn_0", runId: "run_0" },
    data: { callId: name, capability: { kind, name }, owner: { runId: "run_0" } },
  }));
  const events = stampTestEvents([
    ...testTurnFacts(0, "Starting.", ["initial"]).slice(0, 4),
    ...requests,
  ]);
  const subject = {
    derived: deriveRunFacts(events),
    events,
    output: undefined,
    status: "working" as const,
  };
  expect((await calledTool("eve__task_wait", { status: "pending" }).evaluate(subject)).score).toBe(
    1,
  );
  expect((await toolOrder(["lookup", "eve__task_wait", "worker"]).evaluate(subject)).score).toBe(1);
  expect((await toolOrder(["worker", "lookup"]).evaluate(subject)).score).toBe(0);
  expect((await toolOrder(["guide"]).evaluate(subject)).score).toBe(0);
});

interface PendingRequest {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly tool?: string;
}

/** A turn that ends parked on `pending`, each approval asking about a call to its `tool`. */
function parkedOn(
  pending: readonly PendingRequest[],
  {
    status = "awaiting-input",
    extra = [],
  }: { status?: RequestStatus; extra?: SessionEvent[] } = {},
) {
  const scope = { turnId: "turn_0" };
  const run = { runId: "run_0", turnId: "turn_0" };
  const events = stampTestEvents([
    {
      data: { cause: { deliveryId: "d_0" }, follows: null, turnId: "turn_0" },
      scope,
      type: "turn.started",
    },
    ...pending.flatMap(({ id, kind, tool }): SessionEvent[] => {
      const opened = {
        data: {
          interactionId: id,
          request: { kind, prompt: `${kind} ${id}` },
          subject: tool === undefined ? scope : { callId: `call_${id}` },
        },
        scope,
        type: "interaction.opened",
      } as SessionEvent;
      if (tool === undefined) return [opened];
      const requested = {
        data: {
          callId: `call_${id}`,
          capability: { kind: "tool", name: tool },
          input: {},
          owner: { runId: "run_0" },
        },
        scope: run,
        type: "call.requested",
      } as SessionEvent;
      return [requested, opened];
    }),
    {
      data: { awaiting: pending.map(({ id }) => ({ interactionId: id })), turnId: "turn_0" },
      scope,
      type: "turn.paused",
    },
    ...extra,
  ]);
  return { derived: deriveRunFacts(events), events, output: undefined, status };
}

const deployApproval = (id: string): PendingRequest => ({ id, kind: "approval", tool: "deploy" });

it.each<[string, readonly PendingRequest[], number]>([
  ["one approval", [deployApproval("a_0")], 1],
  ["two approvals", [deployApproval("a_0"), deployApproval("a_1")], 1],
  ["a question", [{ id: "q_0", kind: "question" }], 0],
  ["a sign-in", [{ id: "s_0", kind: "sign-in" }], 0],
  ["a budget request", [{ id: "b_0", kind: "budget" }], 0],
  ["an approval and a question", [deployApproval("a_0"), { id: "q_0", kind: "question" }], 0],
])("awaitingInput filters a run parked on %s", async (_label, pending, score) => {
  const subject = parkedOn(pending);

  expect((await awaitingInput().evaluate(subject)).score).toBe(1);
  expect((await awaitingInput({}).evaluate(subject)).score).toBe(1);
  expect((await awaitingInput({ kind: "approval" }).evaluate(subject)).score).toBe(score);
});

it("awaitingInput lists each pending request the filter rejects", async () => {
  const subject = parkedOn([
    deployApproval("a_0"),
    { id: "a_1", kind: "approval", tool: "post_comment" },
    { id: "q_0", kind: "question" },
  ]);

  expect(await awaitingInput({ kind: "approval", toolName: "deploy" }).evaluate(subject)).toEqual({
    score: 0,
    message:
      'expected every pending request to match {"kind":"approval","toolName":"deploy"}; unmatched: kind=approval tool=post_comment interactionId=a_1; kind=question interactionId=q_0',
    metadata: undefined,
  });
});

it("awaitingInput shows RegExp matchers in its failure message", async () => {
  const outcome = await awaitingInput({ prompt: /publish/u }).evaluate(
    parkedOn([deployApproval("a_0")]),
  );

  expect(outcome.message).toContain('{"prompt":"/publish/u"}');
});

it("awaitingInput with a filter fails a run parked on requests the eval didn't read", async () => {
  const events = stampTestEvents([
    {
      data: { awaiting: [{ interactionId: "i_unread" }], turnId: "turn_0" },
      scope: { turnId: "turn_0" },
      type: "turn.paused",
    },
  ]);
  const subject = {
    derived: deriveRunFacts(events),
    events,
    output: undefined,
    status: "awaiting-input" as const,
  };

  expect((await awaitingInput().evaluate(subject)).score).toBe(1);
  expect((await awaitingInput({}).evaluate(subject)).score).toBe(1);
  expect(await awaitingInput({ kind: "approval" }).evaluate(subject)).toMatchObject({
    score: 0,
    message: expect.stringContaining("didn't read"),
  });
});

it("awaitingInput with a filter fails a run that did not park", async () => {
  const events = stampTestEvents(testTurnFacts(0, "Done.", ["d_0"]));
  const subject = {
    derived: deriveRunFacts(events),
    events,
    output: undefined,
    status: "completed" as const,
  };

  expect((await awaitingInput({ kind: "approval" }).evaluate(subject)).score).toBe(0);
});

it.each([
  ["a failed run", parkedOn([deployApproval("a_0")], { status: "failed" }), "run failed"],
  [
    "an error event",
    parkedOn([deployApproval("a_0")], {
      extra: [
        {
          data: { error: { code: "BOOM", message: "Boom." }, outcome: "failed" },
          type: "session.ended",
        } as SessionEvent,
      ],
    }),
    "session.ended (BOOM): Boom.",
  ],
])("awaitingInput fails %s with or without a filter", async (_label, subject, message) => {
  expect(await awaitingInput().evaluate(subject)).toMatchObject({ score: 0, message });
  expect(await awaitingInput({ kind: "approval" }).evaluate(subject)).toMatchObject({
    score: 0,
    message,
  });
});
