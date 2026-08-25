import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { handleTaskInputResponseRequest } from "#runtime/task-input-response-route.js";

const resumeHookMock = vi.fn();
const getHookByTokenMock = vi.fn();
const DIGEST = "0123456789abcdef0123456789abcdef";
const CAPABILITY_TOKEN = `eve:task-input:${DIGEST}`;
const TARGET_TOKEN = `eve:eve:op:${DIGEST}`;
const TARGET_HOOK = {
  metadata: { sessionInboxWireVersion: 1 },
  runId: "child-session",
  token: TARGET_TOKEN,
};

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

// The task-input route now lives inside the framework `eve` channel
// (`packages/eve/src/public/channels/eve.ts`); these tests exercise the
// exported handler directly.
describe("task input response capability", () => {
  beforeEach(() => {
    getHookByTokenMock.mockReset();
    getHookByTokenMock.mockResolvedValue(TARGET_HOOK);
    resumeHookMock.mockReset();
  });

  it("resumes only the addressed child input batch", async () => {
    resumeHookMock.mockResolvedValue(undefined);
    const response = await handleTaskInputResponseRequest(
      request({ inputResponses: [{ optionId: "approve", requestId: "req-1" }] }),
      context(CAPABILITY_TOKEN),
    );

    expect(response.status).toBe(202);
    expect(getHookByTokenMock).toHaveBeenCalledWith(TARGET_TOKEN);
    expect(resumeHookMock).toHaveBeenCalledWith(
      TARGET_HOOK,
      sessionInboxWire.encode(
        {
          kind: "send",
          payload: { inputResponses: [{ optionId: "approve", requestId: "req-1" }] },
        },
        { version: 1 },
      ),
    );
  });

  it("rejects messages and empty response batches", async () => {
    for (const body of [{ message: "not allowed" }, { inputResponses: [] }]) {
      const response = await handleTaskInputResponseRequest(
        request(body),
        context(CAPABILITY_TOKEN),
      );
      expect(response.status).toBe(400);
    }
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("rejects generic workflow hook tokens", async () => {
    const response = await handleTaskInputResponseRequest(
      request({ inputResponses: [{ requestId: "req-1", text: "forged" }] }),
      context("eve:session:victim:inbox"),
    );

    expect(response.status).toBe(403);
    expect(resumeHookMock).not.toHaveBeenCalled();
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
