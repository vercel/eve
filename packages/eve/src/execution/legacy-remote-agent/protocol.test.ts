import { beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { legacyTaskInputRoute } from "#execution/legacy-remote-agent/protocol.js";
import type { RouteContext } from "#public/definitions/channel.js";

const resumeHookMock = vi.fn();
const getHookByTokenMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: (token: string) => getHookByTokenMock(token),
  // Vercel-shaped: owners run on their own deployment, so ingress resumes by token.
  getWorld: async () => ({ capabilities: { deploymentAffinity: true } }),
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));

const DIGEST = "0123456789abcdef0123456789abcdef";
const inputResponses = [{ optionId: "approve", requestId: "request-1" }];

// What an eve 0.66–0.68 caller posts to answer a remote agent's question or approval.
function postAnswers(token: string, body: unknown = { inputResponses }) {
  return legacyTaskInputRoute.handler(
    new Request(`https://remote.example.com/eve/v1/task-input/${token}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: { token }, requestIp: null, waitUntil() {} } satisfies RouteContext,
  );
}

describe("legacy task input route", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
    getHookByTokenMock.mockReset();
  });

  it("delivers answers to the session behind the capability without replacing its principal", async () => {
    getHookByTokenMock.mockImplementation(async (token: string) => ({
      hookId: "hook-1",
      runId: "run-1",
      token,
    }));
    resumeHookMock.mockResolvedValue({ runId: "run-1" });

    const response = await postAnswers(`eve:task-input:${DIGEST}`);

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(`eve:inbox:v1:eve:eve:op:${DIGEST}`, {
      kind: "send",
      payload: { inputResponses },
    });
  });

  it("rejects a token that is not a task input capability", async () => {
    const response = await postAnswers(`eve:eve:op:${DIGEST}`);

    expect(response.status).toBe(403);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("rejects a body without answers", async () => {
    const response = await postAnswers(`eve:task-input:${DIGEST}`, { inputResponses: [] });

    expect(response.status).toBe(400);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("answers 404 so the caller stops retrying once the session is gone", async () => {
    resumeHookMock.mockRejectedValue(new HookNotFoundError("gone"));
    getHookByTokenMock.mockRejectedValue(new HookNotFoundError("gone"));

    const response = await postAnswers(`eve:task-input:${DIGEST}`);

    expect(response.status).toBe(404);
  });
});
