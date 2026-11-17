import { beforeEach, describe, expect, it } from "vitest";

import { testState, installTestState } from "../../../testing/state";
import { recordVisualizationDelivery, visualizationReceipts } from "./receipts";

beforeEach(() => testState.reset());

describe("visualization delivery receipts", () => {
  it("starts without a delivery receipt", () => {
    expect(visualizationReceipts.get()).toBeNull();
  });

  it.each([
    { failed: false, outcomes: [true], posted: true },
    { failed: true, outcomes: [false], posted: false },
    { failed: false, outcomes: [true, true], posted: true },
    { failed: true, outcomes: [false, false], posted: false },
    { failed: true, outcomes: [true, false], posted: true },
    { failed: true, outcomes: [false, true], posted: true },
    { failed: true, outcomes: [true, false, true], posted: true },
  ])(
    "retains all delivery outcomes within a turn: $outcomes",
    ({ failed, outcomes, posted }) => {
      for (const outcome of outcomes) {
        recordVisualizationDelivery("turn-1", outcome);
      }
      expect(visualizationReceipts.get()).toEqual({
        failed,
        posted,
        turnId: "turn-1",
      });
    }
  );

  it.each([true, false])(
    "does not inherit earlier success or failure in a new turn: %s",
    (posted) => {
      recordVisualizationDelivery("turn-1", true);
      recordVisualizationDelivery("turn-1", false);
      recordVisualizationDelivery("turn-2", posted);
      expect(visualizationReceipts.get()).toEqual({
        failed: !posted,
        posted,
        turnId: "turn-2",
      });
    }
  );

  it.each([
    { failed: false, posted: true },
    { failed: true, posted: false },
    { failed: true, posted: true },
  ])("loads saved table state without migration: %j", ({ failed, posted }) => {
    const saved = { failed, posted, turnId: "saved-turn" };
    testState.set("contentful.table-receipts", saved);
    expect(visualizationReceipts.get()).toEqual(saved);
    recordVisualizationDelivery("saved-turn", true);
    expect(testState.get("contentful.table-receipts")).toEqual({
      failed,
      posted: true,
      turnId: "saved-turn",
    });
    expect(testState.names()).toEqual(["contentful.table-receipts"]);
  });

  it("replaces state without mutating a previously returned receipt", () => {
    recordVisualizationDelivery("turn-1", true);
    const previous = visualizationReceipts.get();
    recordVisualizationDelivery("turn-1", false);
    expect(previous).toEqual({ failed: false, posted: true, turnId: "turn-1" });
    expect(visualizationReceipts.get()).toEqual({
      failed: true,
      posted: true,
      turnId: "turn-1",
    });
  });
});

beforeEach(installTestState);
