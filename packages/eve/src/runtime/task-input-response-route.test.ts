import { beforeEach, describe, expect, it, vi } from "vitest";

import { EVE_TASK_INPUT_ROUTE_PATTERN } from "#protocol/routes.js";
import type { RouteContext } from "#public/definitions/channel.js";
import {
  getTaskInputResponseChannelDefinitions,
  handleTaskInputResponseRequest,
} from "#runtime/task-input-response-route.js";

const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));

describe("task input response capability", () => {
  beforeEach(() => resumeHookMock.mockReset());

  it("registers one capability-scoped POST route", () => {
    expect(getTaskInputResponseChannelDefinitions()).toEqual([
      expect.objectContaining({ method: "POST", urlPath: EVE_TASK_INPUT_ROUTE_PATTERN }),
    ]);
  });

  it("resumes only the addressed child input batch", async () => {
    resumeHookMock.mockResolvedValue(undefined);
    const response = await handleTaskInputResponseRequest(
      request({ inputResponses: [{ optionId: "approve", requestId: "req-1" }] }),
      context("child-token"),
    );

    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith("child-token", {
      kind: "send",
      payload: { inputResponses: [{ optionId: "approve", requestId: "req-1" }] },
    });
  });

  it("rejects messages and empty response batches", async () => {
    for (const body of [{ message: "not allowed" }, { inputResponses: [] }]) {
      const response = await handleTaskInputResponseRequest(request(body), context("child-token"));
      expect(response.status).toBe(400);
    }
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
    agent: {
      async cancelTurn() {
        throw new Error("unexpected cancelTurn");
      },
      async deliver() {
        throw new Error("unexpected deliver");
      },
      async getEventStream() {
        throw new Error("unexpected getEventStream");
      },
      async run() {
        throw new Error("unexpected run");
      },
    },
    params: { token },
    requestIp: null,
    waitUntil() {},
  };
}
