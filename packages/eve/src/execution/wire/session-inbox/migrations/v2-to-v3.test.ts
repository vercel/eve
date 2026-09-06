import { describe, expect, it } from "vitest";
import { v2ToV3 } from "./v2-to-v3.js";

it("drops deployment provenance but retains delivery identity for v2", () => {
  expect(
    v2ToV3.down({
      kind: "deliver",
      version: 3,
      payload: {},
      payloads: [],
      deliveryMetadata: [
        {
          acceptedDeploymentId: "dpl_1",
          deliveryId: "delivery-1",
          channelKind: "http",
          channelName: "web",
          payloadIndex: 0,
        },
      ],
    }),
  ).toEqual({
    kind: "deliver",
    version: 2,
    payload: {},
    payloads: [],
    deliveryMetadata: [
      { deliveryId: "delivery-1", channelKind: "http", channelName: "web", payloadIndex: 0 },
    ],
  });
});

describe("session inbox wire v3 migration", () => {
  it("stamps controls with version 3", () => {
    expect(v2ToV3.up({ kind: "clear", version: 2 })).toEqual({
      kind: "clear",
      version: 3,
    });
  });

  it("preserves v2 deliveries without inventing deployment provenance", () => {
    expect(
      v2ToV3.up({
        kind: "deliver",
        payload: { message: "legacy" },
        payloads: [{ message: "legacy" }],
        version: 2,
      }),
    ).toEqual({
      kind: "deliver",
      payload: { message: "legacy" },
      payloads: [{ message: "legacy" }],
      version: 3,
    });
  });
});
