import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { ChannelRequestIdKey } from "#context/keys.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  createWorkflowRuntime,
  LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE,
  turnWorkflowReference,
  workflowEntryReference,
} from "#execution/workflow-runtime.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const getRunMock = vi.fn();
const resumeHookMock = vi.fn();
const startMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getRun: (...args: unknown[]) => getRunMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
  start: (...args: unknown[]) => startMock(...args),
}));

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

afterEach(() => {
  getRunMock.mockReset();
  resumeHookMock.mockReset();
  startMock.mockReset();
  vi.mocked(getCompiledRuntimeAgentBundle).mockReset();
  vi.unstubAllEnvs();
});

describe("workflowEntryReference", () => {
  it("uses the installed eve package identity for the runtime workflow id", () => {
    const packageInfo = resolveInstalledPackageInfo();

    // The runtime references intentionally omit the `@<pkg.version>`
    // stamp so cross-deployment routing (`start(ref, args, {
    // deploymentId: "latest" })`) finds the same workflow on a newer
    // deployment even when eve itself has been upgraded.
    expect(workflowEntryReference.workflowId).toBe(`workflow//${packageInfo.name}//workflowEntry`);
    expect(workflowEntryReference.workflowId).not.toContain("/src/execution/");
    expect(workflowEntryReference.workflowId).not.toContain("@");
    expect(turnWorkflowReference.workflowId).toBe(`workflow//${packageInfo.name}//turnWorkflow`);
    expect(turnWorkflowReference.workflowId).not.toContain("/src/execution/");
    expect(turnWorkflowReference.workflowId).not.toContain("@");
  });
});

describe("createWorkflowRuntime#deliver", () => {
  const NOT_FOUND_TOKEN = "test:no-such-hook";

  function buildRuntime() {
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    return createWorkflowRuntime({ compiledArtifactsSource });
  }

  it("normalizes `HookNotFoundError` into `RuntimeNoActiveSessionError`", async () => {
    const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
    resumeHookMock.mockRejectedValue(new HookNotFoundError(NOT_FOUND_TOKEN));

    const runtime = buildRuntime();

    await expect(
      runtime.deliver({
        auth: null,
        continuationToken: NOT_FOUND_TOKEN,
        payload: {},
      }),
    ).rejects.toSatisfy(isRuntimeNoActiveSessionError);
  });

  it("re-throws unexpected errors from `resumeHook`", async () => {
    const failure = new Error("transient backing-store outage");
    resumeHookMock.mockRejectedValue(failure);

    const runtime = buildRuntime();

    await expect(
      runtime.deliver({
        auth: null,
        continuationToken: NOT_FOUND_TOKEN,
        payload: {},
      }),
    ).rejects.toBe(failure);
  });

  it("resumes hooks with the channel request id", async () => {
    resumeHookMock.mockResolvedValue({ runId: "driver-run" });

    await expect(
      buildRuntime().deliver({
        auth: null,
        continuationToken: "test:token",
        payload: { message: "hello" },
        requestId: "req_deliver",
      }),
    ).resolves.toEqual({ sessionId: "driver-run" });

    expect(resumeHookMock).toHaveBeenCalledWith("test:token", {
      auth: null,
      kind: "deliver",
      payloads: [{ message: "hello" }],
      requestId: "req_deliver",
    });
  });

  it("returns the owner from the hook resumed by the delivery", async () => {
    resumeHookMock.mockResolvedValue({ runId: "owner-session" });

    const runtime = buildRuntime();

    await expect(
      runtime.deliver({
        auth: null,
        continuationToken: "test:active-hook",
        payload: { message: "hello" },
      }),
    ).resolves.toEqual({ sessionId: "owner-session" });
    expect(resumeHookMock).toHaveBeenCalledOnce();
    expect(resumeHookMock).toHaveBeenCalledWith("test:active-hook", {
      auth: null,
      kind: "deliver",
      payloads: [{ message: "hello" }],
    });
  });
});

describe("createWorkflowRuntime#cancelTurn", () => {
  function buildRuntime() {
    return createWorkflowRuntime({ compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource });
  }

  it("resumes the session cancel hook with an optional turn guard", async () => {
    resumeHookMock.mockResolvedValue({ runId: "turn-run" });

    await expect(
      buildRuntime().cancelTurn({ sessionId: "session-1", turnId: "turn-2" }),
    ).resolves.toEqual({ status: "accepted" });
    expect(resumeHookMock).toHaveBeenCalledWith("session-1:cancel", { turnId: "turn-2" });
  });

  it("uses an empty payload for an unguarded cancel", async () => {
    resumeHookMock.mockResolvedValue({ runId: "turn-run" });

    await expect(buildRuntime().cancelTurn({ sessionId: "session-1" })).resolves.toEqual({
      status: "accepted",
    });
    expect(resumeHookMock).toHaveBeenCalledWith("session-1:cancel", {});
  });

  it("maps missing and terminal targets to 'no_active_turn'", async () => {
    const { EntityConflictError, HookNotFoundError, RunExpiredError, WorkflowRunNotFoundError } =
      await import("#compiled/@workflow/errors/index.js");
    const errors = [
      new HookNotFoundError("session-1:cancel"),
      new WorkflowRunNotFoundError("turn-run"),
      new RunExpiredError("turn already completed"),
      new EntityConflictError("turn completed during cancellation"),
    ];

    for (const error of errors) {
      resumeHookMock.mockRejectedValueOnce(error);
      await expect(buildRuntime().cancelTurn({ sessionId: "session-1" })).resolves.toEqual({
        status: "no_active_turn",
      });
    }
  });

  it("rethrows unexpected runtime failures", async () => {
    const failure = new Error("transient backing-store outage");
    resumeHookMock.mockRejectedValue(failure);

    await expect(buildRuntime().cancelTurn({ sessionId: "session-1" })).rejects.toBe(failure);
  });
});

describe("createWorkflowRuntime#run", () => {
  const adapter: ChannelAdapter = { kind: "http" };

  function buildRuntime(compiledArtifactsSource: RuntimeCompiledArtifactsSource) {
    return createWorkflowRuntime({ compiledArtifactsSource });
  }

  function mockBundleAndRun(compiledArtifactsSource: RuntimeCompiledArtifactsSource): void {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      compiledArtifactsSource,
    } as never);
    getRunMock.mockReturnValue({
      getReadable: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    });
  }

  it("starts workflowEntry on the latest deployment in Vercel production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    mockBundleAndRun(compiledArtifactsSource);
    startMock.mockResolvedValue({ runId: "driver-run" });

    await buildRuntime(compiledArtifactsSource).run({
      adapter,
      auth: null,
      input: { message: "hello" },
      mode: "task",
    });

    expect(startMock).toHaveBeenCalledWith(
      workflowEntryReference,
      [
        {
          input: { message: "hello" },
          serializedContext: expect.objectContaining({
            "eve.bundle": { source: compiledArtifactsSource },
            "eve.channel": { kind: "http", state: {} },
            "eve.mode": "task",
          }),
        },
      ],
      {
        allowReservedAttributes: true,
        attributes: {
          "$eve.title": "hello",
          "$eve.trigger": "http",
          "$eve.type": "session",
        },
        deploymentId: "latest",
      },
    );
  });

  it("uses an explicit title without changing the workflow model input", async () => {
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    mockBundleAndRun(compiledArtifactsSource);
    startMock.mockResolvedValue({ runId: "driver-run" });
    const message = "<slack_message>\n<content>ship it</content>\n</slack_message>";

    await buildRuntime(compiledArtifactsSource).run({
      adapter,
      auth: null,
      input: { message },
      mode: "conversation",
      title: "ship it",
    });

    const [, workflowInput, startOptions] = startMock.mock.calls[0]!;
    expect(workflowInput[0].input.message).toBe(message);
    expect(startOptions.attributes["$eve.title"]).toBe("ship it");
  });

  it("serializes the channel request id into workflow context", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    mockBundleAndRun(compiledArtifactsSource);
    startMock.mockResolvedValue({ runId: "driver-run" });

    await buildRuntime(compiledArtifactsSource).run({
      adapter,
      auth: null,
      input: { message: "hello" },
      mode: "task",
      requestId: "req_run",
    });

    expect(startMock).toHaveBeenCalledWith(
      workflowEntryReference,
      [
        {
          input: { message: "hello" },
          serializedContext: expect.objectContaining({
            [ChannelRequestIdKey.name]: "req_run",
          }),
        },
      ],
      {
        allowReservedAttributes: true,
        attributes: {
          "$eve.channel_request_id": "req_run",
          "$eve.title": "hello",
          "$eve.trigger": "http",
          "$eve.type": "session",
        },
        deploymentId: "latest",
      },
    );
  });

  it("seeds subagent lineage attributes when starting a delegated session", async () => {
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      compiledArtifactsSource,
      nodeId: "researcher",
    } as never);
    startMock.mockResolvedValue({ runId: "subagent-run" });

    await createWorkflowRuntime({
      compiledArtifactsSource,
      nodeId: "researcher",
    }).run({
      adapter: { kind: "subagent" },
      auth: null,
      continuationToken: "subagent:parent-session:call-1",
      input: { message: "research this" },
      mode: "task",
      parent: {
        callId: "call-1",
        rootSessionId: "root-session",
        sessionId: "parent-session",
        turn: { id: "turn-1", sequence: 1 },
      },
    });

    expect(startMock).toHaveBeenCalledWith(workflowEntryReference, expect.any(Array), {
      allowReservedAttributes: true,
      attributes: {
        "$eve.parent": "parent-session",
        "$eve.parent_call": "call-1",
        "$eve.parent_turn": "turn-1",
        "$eve.root": "root-session",
        "$eve.subagent": "researcher",
        "$eve.trigger": "subagent",
        "$eve.type": "subagent",
      },
    });
  });

  it("falls back to the current deployment when latest is unsupported", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    mockBundleAndRun(compiledArtifactsSource);
    startMock
      .mockRejectedValueOnce(new Error(LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE))
      .mockResolvedValueOnce({ runId: "driver-run" });

    await buildRuntime(compiledArtifactsSource).run({
      adapter,
      auth: null,
      input: { message: "hello" },
      mode: "task",
    });

    expect(startMock).toHaveBeenNthCalledWith(1, workflowEntryReference, expect.any(Array), {
      allowReservedAttributes: true,
      attributes: {
        "$eve.title": "hello",
        "$eve.trigger": "http",
        "$eve.type": "session",
      },
      deploymentId: "latest",
    });
    expect(startMock).toHaveBeenNthCalledWith(2, workflowEntryReference, expect.any(Array), {
      allowReservedAttributes: true,
      attributes: {
        "$eve.title": "hello",
        "$eve.trigger": "http",
        "$eve.type": "session",
      },
    });
  });

  it.each(["preview", "development", undefined])(
    "pins workflowEntry to the current deployment when VERCEL_ENV is %s",
    async (vercelEnv) => {
      // Preview and CLI deployments carry no git branch reference, so the
      // platform cannot resolve "latest" for them (HTTP 400). They must pin
      // to their own immutable deployment.
      if (vercelEnv === undefined) {
        vi.stubEnv("VERCEL_ENV", "");
        delete process.env.VERCEL_ENV;
      } else {
        vi.stubEnv("VERCEL_ENV", vercelEnv);
      }
      const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
      mockBundleAndRun(compiledArtifactsSource);
      startMock.mockResolvedValue({ runId: "driver-run" });

      await buildRuntime(compiledArtifactsSource).run({
        adapter,
        auth: null,
        input: { message: "hello" },
        mode: "task",
      });

      expect(startMock).toHaveBeenCalledTimes(1);
      expect(startMock).toHaveBeenCalledWith(workflowEntryReference, expect.any(Array), {
        allowReservedAttributes: true,
        attributes: {
          "$eve.title": "hello",
          "$eve.trigger": "http",
          "$eve.type": "session",
        },
      });
    },
  );

  it("does not open the workflow event stream until the events stream is read", async () => {
    const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      compiledArtifactsSource,
    } as never);
    const bytes = new TextEncoder().encode('{"type":"test.event"}\n');
    const getReadable = vi.fn(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    );
    getRunMock.mockReturnValue({ getReadable });
    startMock.mockResolvedValue({ runId: "driver-run" });

    const handle = await buildRuntime(compiledArtifactsSource).run({
      adapter,
      auth: null,
      input: { message: "hello" },
      mode: "task",
    });

    expect(getRunMock).not.toHaveBeenCalled();
    expect(getReadable).not.toHaveBeenCalled();

    const reader = handle.events.getReader();
    const event = await reader.read();
    reader.releaseLock();

    expect(event.value).toEqual({ type: "test.event" });
    expect(getRunMock).toHaveBeenCalledWith("driver-run");
    expect(getReadable).toHaveBeenCalledTimes(1);
  });
});
