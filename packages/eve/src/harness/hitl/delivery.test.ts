import { expect, it } from "vitest";

import { resolveTextInput } from "#harness/hitl/delivery.js";
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
