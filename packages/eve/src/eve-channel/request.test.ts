import { describe, expect, it } from "vitest";

import { parseCreateBody, parseSessionMessageBody } from "#eve-channel/request.js";

describe("parseCreateBody", () => {
  it("accepts a conversation session without a message", () => {
    expect(parseCreateBody({})).toEqual({
      activityObserver: undefined,
      callback: undefined,
      capabilities: undefined,
      context: undefined,
      mode: undefined,
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

  it("requires a message for task mode", async () => {
    const response = parseCreateBody({ mode: "task" });
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: "Task sessions require a non-empty 'message'.",
    });
  });
});

describe("session context input", () => {
  it.each([{ value: null }, { value: [] }, { value: "docs" }, { value: 42 }])(
    "rejects a non-object context: $value",
    async ({ value: sessionContext }) => {
      const response = parseCreateBody({ sessionContext });
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(400);
      await expect((response as Response).json()).resolves.toMatchObject({
        error: "Expected 'sessionContext' to be a JSON object.",
      });
    },
  );

  it("rejects attempts to replace context on an existing session", async () => {
    const response = parseSessionMessageBody({
      message: "Hello",
      sessionContext: { surface: "support" },
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: "'sessionContext' is only accepted when creating a session.",
    });
  });
});
