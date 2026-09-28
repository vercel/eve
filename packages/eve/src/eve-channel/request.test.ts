import { describe, expect, it } from "vitest";

import { parseCreateBody } from "#eve-channel/request.js";

describe("parseCreateBody", () => {
  it("accepts a conversation session without a message", () => {
    expect(parseCreateBody({})).toEqual({
      activityObserver: undefined,
      callback: undefined,
      capabilities: undefined,
      context: undefined,
      outputSchema: undefined,
    });
  });

  it("rejects an explicitly empty message", async () => {
    const response = parseCreateBody({ message: "" });
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: "Expected 'message' to be non-empty when provided.",
    });
  });

  it("rejects turn-only fields without a message", async () => {
    const response = parseCreateBody({ clientContext: "page context" });
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: expect.stringContaining("does not accept"),
    });
  });
});
