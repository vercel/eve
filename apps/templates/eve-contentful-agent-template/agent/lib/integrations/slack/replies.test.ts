import { beforeEach, expect, it } from "vitest";

import { messageCompletedHarness } from "../../testing/slack";
import { testState, installTestState } from "../../testing/state";
import { replyEvents } from "./replies";
import { recordVisualizationDelivery } from "./visualizations/receipts";

beforeEach(() => {
  testState.reset();
  installTestState();
});

it("suppresses duplicate prose after a successful visualization", async () => {
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  recordVisualizationDelivery("turn-1", true);
  await harness.complete();
  expect(harness.next).not.toHaveBeenCalled();
});
it("keeps the normal response after any failed visualization", async () => {
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  recordVisualizationDelivery("turn-1", true);
  recordVisualizationDelivery("turn-1", false);
  await harness.complete();
  expect(harness.next).toHaveBeenCalledOnce();
});
it("does not suppress later turns or narration", async () => {
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  recordVisualizationDelivery("older-turn", true);
  await harness.complete();
  recordVisualizationDelivery("turn-1", true);
  await harness.complete({
    data: {
      kind: "text",
      partId: "narration",
      phase: "narration",
      value: "Checking the guides.",
    },
  });
  expect(harness.next).toHaveBeenCalledTimes(2);
});
