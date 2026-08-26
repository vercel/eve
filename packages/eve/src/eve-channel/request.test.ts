import { describe, expect, it } from "vitest";

import {
  deriveOperationContinuationToken,
  parseCreateBody,
  parseSessionMessageBody,
} from "#eve-channel/request.js";

const auth = {
  attributes: {},
  authenticator: "test",
  principalId: "user_1",
  principalType: "user",
};

describe("eve request agent selector", () => {
  it("parses agent on creates and message turns", () => {
    expect(parseCreateBody({ agent: "researcher", message: "hello" })).toMatchObject({
      agent: "researcher",
      message: "hello",
    });
    expect(parseSessionMessageBody({ agent: "researcher", message: "hello" })).toMatchObject({
      agent: "researcher",
      message: "hello",
    });
  });

  it("rejects agent alongside HITL responses", async () => {
    const parsed = parseSessionMessageBody({
      agent: "researcher",
      inputResponses: [{ requestId: "request_1", text: "yes" }],
    });
    expect(parsed).toBeInstanceOf(Response);
    expect((parsed as Response).status).toBe(400);
    await expect((parsed as Response).json()).resolves.toMatchObject({
      error: expect.stringContaining("cannot be sent alongside"),
    });
  });

  it("preserves root operation identity and isolates targeted creates", async () => {
    const root = await deriveOperationContinuationToken({ auth, operationId: "op_1" });
    const rootAgain = await deriveOperationContinuationToken({ auth, operationId: "op_1" });
    const researcher = await deriveOperationContinuationToken({
      agent: "researcher",
      auth,
      operationId: "op_1",
    });
    const critic = await deriveOperationContinuationToken({
      agent: "researcher/critic",
      auth,
      operationId: "op_1",
    });

    expect(rootAgain).toBe(root);
    expect(new Set([root, researcher, critic])).toHaveLength(3);
  });
});
