import { describe, expect, it } from "vitest";

import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";

describe("coalesceDeliverPayloads", () => {
  it("keeps the first response when concurrent deliveries answer the same request", () => {
    expect(
      coalesceDeliverPayloads([
        { inputResponses: [{ optionId: "approve", requestId: "REQ" }] },
        { inputResponses: [{ optionId: "deny", requestId: "REQ" }] },
      ]),
    ).toEqual({
      inputResponses: [{ optionId: "approve", requestId: "REQ" }],
    });
  });

  it("preserves responses for distinct pending requests", () => {
    expect(
      coalesceDeliverPayloads([
        { inputResponses: [{ optionId: "approve", requestId: "REQ_1" }] },
        { inputResponses: [{ optionId: "deny", requestId: "REQ_2" }] },
      ]),
    ).toEqual({
      inputResponses: [
        { optionId: "approve", requestId: "REQ_1" },
        { optionId: "deny", requestId: "REQ_2" },
      ],
    });
  });
});
