import { expect, it } from "vitest";

import { deliver, resolveTextInput } from "#harness/hitl/delivery.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { HarnessSession } from "#harness/types.js";
import { withOpenTurn, withPublished, withQueuedInput } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLines } from "#protocol/session-projection/fold.js";

it.each([
  {
    name: "only the oldest matching prompt",
    firstOption: "approve",
    budget: false,
    expected: "first",
  },
  {
    name: "no later prompt when the shown prompt does not match",
    firstOption: "blue",
    budget: false,
    expected: undefined,
  },
  {
    name: "the budget prompt before older approvals",
    firstOption: "approve",
    budget: true,
    expected: "budget",
  },
])("typed replies answer $name", ({ firstOption, budget, expected }) => {
  const view = emptySessionView();
  const opened = (interactionId: string, kind: "approval" | "budget", optionId: string) => ({
    type: "interaction.opened",
    data: {
      interactionId,
      subject: { turnId: "turn_0" },
      request: { kind, prompt: "Choose an option", options: [{ id: optionId, label: optionId }] },
    },
  });
  foldLines(
    view,
    [
      {
        at: "2026-10-15T00:00:00Z",
        facts: [
          opened("first", "approval", firstOption),
          opened("second", "approval", "approve"),
          ...(budget ? [opened("budget", "budget", "approve")] : []),
        ],
      },
    ],
    0,
  );
  const input = { message: "approve", deliveries: [{ deliveryId: "incoming", parts: [] }] };
  const result = resolveTextInput(view, input);
  if (expected === undefined) {
    expect(result).toBe(input);
  } else {
    expect(result?.answers).toEqual([
      {
        interactionId: expected,
        optionId: "approve",
        deliveryId: "incoming",
        responseId: "response_incoming_typed_0",
      },
    ]);
    expect(result?.message).toBeUndefined();
  }
});

it("drops the history a typed answer brought, from its input and its deliveries", () => {
  const view = emptySessionView();
  foldLines(
    view,
    [
      {
        at: "2026-10-15T00:00:00Z",
        facts: [
          {
            type: "interaction.opened",
            data: {
              interactionId: "budget",
              subject: { turnId: "turn_0" },
              request: {
                kind: "budget",
                prompt: "Keep going?",
                options: [{ id: "approve", label: "approve" }],
              },
            },
          },
        ],
      },
    ],
    0,
  );
  const history = [{ role: "user" as const, text: "Alice asked for the weekly report." }];
  const result = resolveTextInput(view, {
    deliveries: [{ deliveryId: "incoming", history, parts: [{ kind: "text", text: "approve" }] }],
    history,
    message: "approve",
  });
  expect(result?.messageConsumed).toBe(true);
  expect(result?.history).toBeUndefined();
  expect(result?.deliveries).toEqual([
    { deliveryId: "incoming", parts: [{ kind: "text", text: "approve" }] },
  ]);
});

it.each([
  { asker: "this session", answered: true },
  { asker: "a child session", answered: false },
])("typed text behind queued input answers a budget prompt $asker asked", ({ answered }) => {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "alice",
    history: [],
    sessionId: "alice",
  };
  const turn = withOpenTurn(base, { sequence: 0, stepIndex: 0, turnId: "turn_0" });
  const relayed = !answered;
  const session = withQueuedInput(
    withPublished(turn, [
      ...(relayed
        ? ([
            {
              data: { owner: { turnId: "turn_0" }, runId: "run_0" },
              scope: { turnId: "turn_0" },
              type: "model.requested",
            },
            {
              data: {
                callId: "call_reviewer",
                capability: { kind: "agent", name: "reviewer" },
                input: {},
                owner: { runId: "run_0" },
              },
              scope: { turnId: "turn_0" },
              type: "call.requested",
            },
          ] as SessionEvent[])
        : []),
      {
        data: {
          interactionId: "budget",
          ...(relayed && { origin: { interactionId: "child-budget", sessionId: "bob" } }),
          request: {
            kind: "budget",
            options: [{ id: "approve", label: "approve" }],
            prompt: "Keep going?",
          },
          subject: relayed ? { callId: "call_reviewer" } : { turnId: "turn_0" },
        },
        scope: { turnId: "turn_0" },
        type: "interaction.opened",
      },
    ]),
    { message: "Alice also wants the summary." },
  );

  const delivered = deliver(
    sessionView(storedProjection(session.state), session.state),
    { deliveries: [{ deliveryId: "incoming", parts: [] }], message: "approve" },
    { takeQueued: true },
  );

  // A child's prompt takes typed text only through the relay proxy, which checks who typed it.
  // Here the text stays with the queued message instead of vanishing as a stale answer.
  expect(
    delivered.input?.answers?.map(({ interactionId, optionId }) => [interactionId, optionId]),
  ).toEqual(answered ? [["budget", "approve"]] : undefined);
  expect(delivered.input?.message).toBe(
    answered ? "Alice also wants the summary." : "Alice also wants the summary.\n\napprove",
  );
});
