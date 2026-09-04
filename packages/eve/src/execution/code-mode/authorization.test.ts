import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { executeCodeModeTool } from "#execution/code-mode/authorization.js";
import type { CodeModeToolOutcome } from "#execution/code-mode/program-step.js";
import { attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { ToolContext } from "#tools/definition.js";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  createHook: vi.fn(),
  dispose: vi.fn(),
  execute: vi.fn<(...args: unknown[]) => Promise<CodeModeToolOutcome>>(),
  publish: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", async (original) => ({
  ...(await original()),
  createHook: mocks.createHook,
}));
vi.mock("#execution/hook-ownership.js", () => ({
  claimHookOwnership: mocks.claim,
  disposeHook: mocks.dispose,
}));
vi.mock("#execution/code-mode/program-step.js", () => ({ executeCodeModeToolStep: mocks.execute }));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: mocks.publish }));

const input = {
  callId: "outer",
  event: { sequence: 1, stepIndex: 2, turnId: "turn" },
  serializedContext: {},
  sessionState: {} as never,
  toolCallId: "inner",
  toolInput: {},
  toolName: "lookup",
};

function context(signal = new AbortController().signal): ToolContext {
  const ctx = { callId: "outer", abortSignal: signal } as ToolContext;
  attachWorkflowToolRunContext(ctx, {
    from: {
      callId: "outer",
      execution: "blocking",
      input: {},
      runId: "code-mode-run",
      sequence: 1,
      stepIndex: 2,
      toolName: "code_mode",
      turnId: "turn",
    },
    owner: {
      admission: "admission",
      outcome: "outcome",
      report: "report",
      request: "parent-request",
    },
  });
  return ctx;
}

function challenge(name = "service"): AuthorizationChallenge {
  return {
    attemptId: `${name}-attempt`,
    name,
    challenge: { url: "https://idp.example/authorize" },
    hookUrl: `https://app.example/callback/${name}`,
    principal: { type: "user", id: "caller" },
    resume: { verifier: `${name}-verifier` },
  };
}

function callback(name = "service", attemptId = `${name}-attempt`): DeliverHookPayload {
  return {
    kind: "deliver",
    payloads: [
      {
        authorizationCallback: {
          connectionName: name,
          attemptId,
          callback: { method: "GET", params: { code: `${name}-code` } },
        },
      },
    ],
  };
}

function hook(deliveries: DeliverHookPayload[]) {
  const next = vi.fn(async () =>
    deliveries.length > 0
      ? { done: false as const, value: deliveries.shift()! }
      : await new Promise<IteratorResult<DeliverHookPayload>>(() => {}),
  );
  const value = { token: "nested-auth", [Symbol.asyncIterator]: () => ({ next }) };
  mocks.createHook.mockReturnValue(value);
  return { next, value };
}

beforeEach(() => vi.resetAllMocks());

describe("code mode authorization", () => {
  it("executes an authorized call once and disposes its unused callback hook", async () => {
    const { value } = hook([]);
    mocks.execute.mockResolvedValueOnce({ status: "completed", output: "done" });
    await expect(executeCodeModeTool(context(), input)).resolves.toEqual({
      status: "completed",
      output: "done",
    });
    expect(mocks.claim).toHaveBeenCalledWith(value);
    expect(mocks.execute).toHaveBeenCalledWith({ ...input, authorizationHookToken: "nested-auth" });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledWith(value);
  });

  it("ignores a stale callback and retries only the pending tool with its saved authorization state", async () => {
    const { next } = hook([callback("service", "stale"), callback()]);
    mocks.execute
      .mockResolvedValueOnce({ status: "authorization-required", challenges: [challenge()] })
      .mockResolvedValueOnce({ status: "completed", output: "authorized" });

    await expect(executeCodeModeTool(context(), input)).resolves.toEqual({
      status: "completed",
      output: "authorized",
    });
    expect(next).toHaveBeenCalledTimes(2);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[1]?.[0]).toMatchObject({
      toolCallId: "inner",
      authorizationResults: [
        {
          attemptId: "service-attempt",
          name: "service",
          hookUrl: challenge().hookUrl,
          principal: challenge().principal,
          resume: challenge().resume,
          callback: { method: "GET", params: { code: "service-code" } },
        },
      ],
    });
    expect(mocks.publish.mock.calls.map((call) => call[1].request.event.event.type)).toEqual([
      "authorization.required",
      "authorization.completed",
    ]);
    expect(mocks.publish.mock.calls[0]?.[1]).toMatchObject({
      request: {
        event: {
          childSessionId: "code-mode-run",
          event: { data: { attemptId: "service-attempt", webhookUrl: challenge().hookUrl } },
        },
      },
    });
    expect(mocks.publish.mock.calls[1]?.[1].request.event.event.data.outcome).toBe("authorized");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("waits for every challenged connection and ignores duplicate callbacks", async () => {
    const { next } = hook([callback("b"), callback("b"), callback("a")]);
    mocks.execute
      .mockResolvedValueOnce({
        status: "authorization-required",
        challenges: [challenge("a"), challenge("b")],
      })
      .mockImplementationOnce(async (call) => {
        expect(next).toHaveBeenCalledTimes(3);
        expect(call).toMatchObject({ authorizationResults: [{ name: "b" }, { name: "a" }] });
        return { status: "completed", output: "done" };
      });
    await expect(executeCodeModeTool(context(), input)).resolves.toEqual({
      status: "completed",
      output: "done",
    });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it("reports failed token completion and returns a catchable tool failure", async () => {
    hook([callback()]);
    mocks.execute
      .mockResolvedValueOnce({ status: "authorization-required", challenges: [challenge()] })
      .mockResolvedValueOnce({ status: "failed", error: "Token rejected" });
    await expect(executeCodeModeTool(context(), input)).resolves.toEqual({
      status: "failed",
      error: "Token rejected",
    });
    expect(mocks.publish.mock.calls[1]?.[1].request.event.event.data).toMatchObject({
      outcome: "failed",
      reason: "Token rejected",
    });
  });

  it("cancels the wait and closes its callback hook without retrying the tool", async () => {
    hook([]);
    mocks.execute.mockResolvedValueOnce({
      status: "authorization-required",
      challenges: [challenge()],
    });
    const controller = new AbortController();
    const work = executeCodeModeTool(context(controller.signal), input);
    const rejected = expect(work).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.publish.mock.calls[1]?.[1].request.event.event.data).toMatchObject({
      outcome: "failed",
      reason: "cancelled",
    });
  });

  it("settles the authorization event if restoring the resumed tool fails", async () => {
    hook([callback()]);
    mocks.execute
      .mockResolvedValueOnce({ status: "authorization-required", challenges: [challenge()] })
      .mockRejectedValueOnce(new Error("Tool removed"));
    await expect(executeCodeModeTool(context(), input)).rejects.toThrow("Tool removed");
    expect(mocks.publish.mock.calls[1]?.[1].request.event.event.data).toMatchObject({
      outcome: "failed",
      reason: "Tool removed",
    });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("does not wait for a callback when the parent cannot receive the authorization request", async () => {
    const { next } = hook([]);
    mocks.execute.mockResolvedValueOnce({
      status: "authorization-required",
      challenges: [challenge()],
    });
    mocks.publish.mockRejectedValueOnce(new Error("Owner gone"));
    await expect(executeCodeModeTool(context(), input)).rejects.toThrow("Owner gone");
    expect(mocks.publish.mock.calls[0]?.[2]).toEqual({ ifPresent: false });
    expect(next).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
