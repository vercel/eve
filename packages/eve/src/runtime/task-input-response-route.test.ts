import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { sendCommandToDelivery } from "#execution/session-command-wire.js";
import { handleTaskInputResponseRequest } from "#runtime/task-input-response-route.js";

const resumeHookMock = vi.fn();
const DIGEST = "0123456789abcdef0123456789abcdef";
const CAPABILITY_TOKEN = `eve:task-input:${DIGEST}`;
const TARGET_TOKEN = `eve:eve:op:${DIGEST}`;
const RESPONDER: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));

describe("task input response capability", () => {
  beforeEach(() => resumeHookMock.mockReset());

  it("delivers the authenticated responder only to the addressed child", async () => {
    resumeHookMock.mockResolvedValue(undefined);
    const inputResponses = [{ optionId: "approve", requestId: "req-1" }];
    const response = await handleTaskInputResponseRequest({
      auth: RESPONDER,
      inputResponses,
      token: CAPABILITY_TOKEN,
    });

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(
      TARGET_TOKEN,
      sendCommandToDelivery({
        auth: RESPONDER,
        kind: "send",
        payload: { inputResponses },
      }),
    );
  });

  it("rejects generic workflow hook tokens", async () => {
    const response = await handleTaskInputResponseRequest({
      auth: RESPONDER,
      inputResponses: [{ requestId: "req-1", text: "forged" }],
      token: "eve:session:victim:inbox",
    });

    expect(response.status).toBe(403);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });
});
