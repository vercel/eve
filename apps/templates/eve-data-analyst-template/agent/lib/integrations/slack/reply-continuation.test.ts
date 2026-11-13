import type { HookEvent } from "eve/hooks";
import { beforeEach, expect, it } from "vitest";

import { hookContext, eventView } from "../../testing/events";
import { installTestState, testState } from "../../testing/state";
import hook from "./reply-continuation";
import { visualizationReceipts } from "./visualizations/receipts";

const settled = hook.events?.["interaction.settled"];
const started = hook.events?.["turn.started"];
if (!settled || !started) {
  throw new Error("Expected interaction and turn hooks.");
}
const start = (turnId: string): HookEvent<"turn.started"> => ({
  data: { cause: { deliveryId: "delivery-1" }, follows: null, turnId },
  type: "turn.started",
});
const sourceReceipt = { failed: true, posted: true, turnId: "turn-1" };
const context = (kind: "budget" | "question" = "budget", slack = true) =>
  hookContext({
    channel: slack
      ? { kind: "channel:slack", metadata: {} }
      : { kind: "channel:eve", metadata: {} },
    view: eventView([
      start("turn-1"),
      {
        data: {
          interactionId: "limit-1",
          request: { kind, prompt: "Continue?" },
          subject: { turnId: "turn-1" },
        },
        type: "interaction.opened",
      },
    ]),
  });
beforeEach(() => {
  testState.reset();
  installTestState();
  visualizationReceipts.update(() => sourceReceipt);
});

it("transfers reply ownership once after a budget continuation", async () => {
  await settled(
    {
      data: { interactionId: "limit-1", outcome: "accepted" },
      type: "interaction.settled",
    },
    context()
  );
  await started(start("turn-2"), context());
  expect(visualizationReceipts.get()).toEqual({
    ...sourceReceipt,
    turnId: "turn-2",
  });
  visualizationReceipts.update(() => sourceReceipt);
  await started(start("turn-3"), context());
  expect(visualizationReceipts.get()).toEqual(sourceReceipt);
});
it.each([
  ["budget", "declined", true],
  ["question", "accepted", true],
  ["budget", "accepted", false],
] as const)(
  "does not transfer after %s/%s in Slack=%s",
  async (kind, outcome, slack) => {
    await settled(
      {
        data: { interactionId: "limit-1", outcome },
        type: "interaction.settled",
      },
      context(kind, slack)
    );
    await started(start("turn-2"), context());
    expect(visualizationReceipts.get()).toEqual(sourceReceipt);
  }
);
it("does not retarget a receipt replaced before the next turn", async () => {
  await settled(
    {
      data: { interactionId: "limit-1", outcome: "accepted" },
      type: "interaction.settled",
    },
    context()
  );
  const replacement = { ...sourceReceipt, turnId: "other-turn" };
  visualizationReceipts.update(() => replacement);
  await started(start("turn-2"), context());
  expect(visualizationReceipts.get()).toEqual(replacement);
});
