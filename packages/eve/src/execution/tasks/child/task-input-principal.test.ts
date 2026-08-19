import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { deserializeContext } from "#context/serialize.js";
import { resolveRemoteAgentStreamHeaders } from "#execution/remote-agent-dispatch.js";
import { deliverTaskInputResponsesStep } from "#execution/tasks/child/steps.js";
import type { TaskInboundAnswerInput } from "#tasks/types.js";

const resumeHookMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));
vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/remote-agent-dispatch.js", () => ({
  resolveRemoteAgentStreamHeaders: vi.fn(),
}));

const DIGEST = "0123456789abcdef0123456789abcdef";
const CHILD_TOKEN = `eve:eve:op:${DIGEST}`;
const CAPABILITY_TOKEN = `eve:task-input:${DIGEST}`;
const RESPONDER: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "parent-user",
  principalType: "user",
};

afterEach(() => {
  resumeHookMock.mockReset();
  vi.mocked(deserializeContext).mockReset();
  vi.mocked(resolveRemoteAgentStreamHeaders).mockReset();
  vi.unstubAllGlobals();
});

describe("task input responder delivery", () => {
  it("puts the responding parent principal on a local child command", async () => {
    resumeHookMock.mockResolvedValue(undefined);

    await expect(deliverTaskInputResponsesStep(delivery(answer()))).resolves.toBe("delivered");

    expect(resumeHookMock).toHaveBeenCalledWith(
      "local-child-token",
      expect.objectContaining({
        auth: RESPONDER,
        payload: { inputResponses: [{ optionId: "approve", requestId: "approval-1" }] },
      }),
    );
  });

  it("uses the remote target's current credentials and forwarding policy", async () => {
    const bundle = {} as never;
    vi.mocked(deserializeContext).mockResolvedValue({ require: () => bundle } as never);
    vi.mocked(resolveRemoteAgentStreamHeaders).mockResolvedValue({
      authorization: "Bearer current",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deliverTaskInputResponsesStep(
        delivery(
          answer({
            target: {
              continuationToken: CHILD_TOKEN,
              forwardPrincipal: true,
              kind: "remote",
              name: "child",
              resolverId: "dynamic/current-child",
              serializedBundle: { source: "compiled" },
              url: "https://child.example",
            },
          }),
        ),
      ),
    ).resolves.toBe("delivered");

    expect(resolveRemoteAgentStreamHeaders).toHaveBeenCalledWith({
      bundle,
      name: "child",
      resolverId: "dynamic/current-child",
      url: "https://child.example",
    });
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      forwardedPrincipal: { current: RESPONDER },
      inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://child.example/eve/v1/task-input/${encodeURIComponent(CAPABILITY_TOKEN)}`,
      expect.objectContaining({
        headers: {
          authorization: "Bearer current",
          "content-type": "application/json",
        },
      }),
    );
  });
});

function answer(overrides: Partial<TaskInboundAnswerInput> = {}): TaskInboundAnswerInput {
  return {
    auth: RESPONDER,
    inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
    kind: "input-response",
    target: { continuationToken: "local-child-token", kind: "local" },
    taskId: "task-1",
    ...overrides,
  };
}

function delivery(answerInput: TaskInboundAnswerInput) {
  return { answer: answerInput, requestIds: ["approval-1"] };
}
