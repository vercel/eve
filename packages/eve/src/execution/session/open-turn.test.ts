import { describe, expect, it } from "vitest";

import { deliveriesReadBy, openAfter, openedBy } from "#execution/session/open-turn.js";

describe("where an open turn goes on", () => {
  it("is the next step after one that continues, and none once the turn parked or ended", () => {
    expect(openAfter({ action: "continue", stateDelta: {} })).toEqual({ at: "step" });
    expect(openAfter({ action: "parked", stateDelta: {} })).toBeUndefined();
    expect(openAfter({ action: "done", stateDelta: {} })).toBeUndefined();
  });

  it("keeps only the pause a paused step names, not the rest of its result", () => {
    expect(
      openAfter({
        action: "paused",
        attemptIds: [],
        on: "interaction",
        requestIds: ["request-1"],
        stateDelta: {},
      }),
    ).toEqual({
      at: "pause",
      pause: { attemptIds: [], on: "interaction", requestIds: ["request-1"] },
    });
  });

  it("names the deliveries the step it goes on with reads from its own input", () => {
    const open = openedBy({
      deliveryMetadata: [
        { channelKind: "http", channelName: "http", deliveryId: "delivery-1", payloadIndex: 0 },
      ],
      kind: "deliver",
      payloads: [],
    });
    expect(deliveriesReadBy(open)).toEqual(["delivery-1"]);
    expect(
      deliveriesReadBy({ at: "cancel", control: { deliveryId: "cancel-1" }, report: false }),
    ).toEqual(["cancel-1"]);
    expect(deliveriesReadBy(undefined)).toEqual([]);
  });
});
