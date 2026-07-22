import { describe, expect, it } from "vitest";

import { parseLoopDeliveryMessage } from "./delivery-message.js";

describe("parseLoopDeliveryMessage", () => {
  it("accepts the plain-text payload shape materialized by channel.send", () => {
    expect(
      parseLoopDeliveryMessage(
        {
          continuationToken: "loop-token",
          payload: {
            context: undefined,
            inputResponses: undefined,
            message: "again",
            outputSchema: undefined,
          },
        },
        "Workflow",
      ),
    ).toBe("again");
  });

  it("rejects defined non-message input", () => {
    expect(() =>
      parseLoopDeliveryMessage(
        {
          continuationToken: "loop-token",
          payload: { context: ["hidden"], message: "again" },
        },
        "Temporal",
      ),
    ).toThrow("Temporal loop runtime only supports plain-text follow-up deliveries.");
  });
});
