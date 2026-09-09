import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteContext } from "#public/definitions/channel.js";
import { handleTaskInputResponseRequest } from "#execution/task-input-response-route.js";

const dispatchMock = vi.fn();
const DIGEST = "0123456789abcdef0123456789abcdef";
const CAPABILITY_TOKEN = `eve:task-input:${DIGEST}`;
const TARGET_TOKEN = `eve:eve:op:${DIGEST}`;
vi.mock("#execution/session/ingress.js", () => ({
  dispatchSessionCommandByToken: (...args: unknown[]) => dispatchMock(...args),
}));

describe("task input response capability", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
  });

  it("dispatches only the addressed child input batch", async () => {
    dispatchMock.mockResolvedValue(undefined);
    const response = await handleTaskInputResponseRequest(
      request({ inputResponses: [{ optionId: "approve", requestId: "req-1" }] }),
      context(CAPABILITY_TOKEN),
    );

    expect(response.status).toBe(202);
    expect(dispatchMock).toHaveBeenCalledWith(TARGET_TOKEN, {
      kind: "send",
      payload: { inputResponses: [{ optionId: "approve", requestId: "req-1" }] },
    });
  });

  it("rejects messages and empty response batches", async () => {
    for (const body of [{ message: "not allowed" }, { inputResponses: [] }]) {
      const response = await handleTaskInputResponseRequest(
        request(body),
        context(CAPABILITY_TOKEN),
      );
      expect(response.status).toBe(400);
    }
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("rejects generic workflow hook tokens", async () => {
    const response = await handleTaskInputResponseRequest(
      request({ inputResponses: [{ requestId: "req-1", text: "forged" }] }),
      context("eve:session:victim:inbox"),
    );

    expect(response.status).toBe(403);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

function request(body: unknown): Request {
  return new Request("https://remote.example/eve/v1/task-input/child-token", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function context(token: string): RouteContext {
  return {
    params: { token },
    requestIp: null,
    waitUntil() {},
  };
}
