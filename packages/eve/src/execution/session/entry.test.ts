import { beforeEach, describe, expect, it, vi } from "vitest";

import { bootInitialOwner } from "#execution/session/entry.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import {
  cancelSessionTimeoutStep,
  startSessionTimeoutStep,
} from "#execution/session/timeout-steps.js";
import { resolveInitialTurnCallerStep } from "#subagents/parent-notification.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import { settleContinuationConflictStep } from "#execution/continuation-conflict-step.js";
import { createTurnControl } from "#execution/session/turn-control.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

const mocks = vi.hoisted(() => ({
  failSession: vi.fn(async ({ error }: { error: unknown }) => {
    throw error;
  }),
  getWritable: vi.fn(() => new WritableStream<Uint8Array>()),
}));

vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({
    workflowRunId: "session-1",
    workflowStartedAt: new Date("2026-02-01T00:00:00.000Z"),
  }),
  getWritable: mocks.getWritable,
}));

vi.mock("./program.js", () => ({
  failSession: mocks.failSession,
  runPreparedSession: vi.fn(),
}));

vi.mock("../create-session-step.js", () => ({ createSessionStep: vi.fn() }));
vi.mock("../session-inbox/inbox.js", () => ({ createSessionInbox: vi.fn() }));
vi.mock("./timeout-steps.js", () => ({
  cancelSessionTimeoutStep: vi.fn(),
  startSessionTimeoutStep: vi.fn(),
}));
vi.mock("./turn-control.js", () => ({ createTurnControl: vi.fn() }));
vi.mock("#subagents/parent-notification.js", () => ({
  resolveInitialTurnCallerStep: vi.fn(),
}));
vi.mock("../delegated-session-context.js", () => ({ hasDelegatedSessionContext: vi.fn() }));
vi.mock("../continuation-conflict-step.js", () => ({
  settleContinuationConflictStep: vi.fn(),
}));
vi.mock("../hook-ownership.js", () => ({
  isHookConflictError: (error: unknown) =>
    typeof error === "object" && error !== null && "hookConflict" in error,
}));
vi.mock("../eve-workflow-attributes.js", () => ({
  readChannelRequestId: vi.fn(),
  readRootSessionId: vi.fn(),
}));

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function initialInput(overrides: Record<string, unknown> = {}) {
  return {
    input: { message: "hello" },
    kind: "initial" as const,
    ownerDeploymentId: "deployment-1",
    serializedContext: {
      "eve.bundle": { source: { kind: "bundled" } },
      ...(overrides.serializedContext as Record<string, unknown> | undefined),
    },
    ...overrides,
  } as Parameters<typeof bootInitialOwner>[0];
}

function createInbox() {
  return {
    claimSessionHook: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createSessionStep).mockResolvedValue({ history: [], state: {} } as never);
  vi.mocked(startSessionTimeoutStep).mockResolvedValue({ runId: "timeout-run-1" });
  vi.mocked(cancelSessionTimeoutStep).mockResolvedValue(undefined);
  vi.mocked(createTurnControl).mockImplementation(() => ({
    cancellation: new AbortController(),
    dispose: vi.fn(),
    steering: new AbortController(),
  }));
  vi.mocked(resolveInitialTurnCallerStep).mockResolvedValue(undefined);
  vi.mocked(hasDelegatedSessionContext).mockReturnValue(false);
  vi.mocked(settleContinuationConflictStep).mockResolvedValue(undefined);
});

describe("bootInitialOwner timeout startup", () => {
  it("prepares controls and starts the timeout while session creation is pending", async () => {
    const sessionCreation = deferred<never>();
    const timeoutStartup = deferred<{ runId: string }>();
    const inbox = createInbox();
    vi.mocked(createSessionStep).mockReturnValue(sessionCreation.promise);
    vi.mocked(startSessionTimeoutStep).mockReturnValue(timeoutStartup.promise);
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);

    const bootPromise = bootInitialOwner(initialInput(), "session-1");

    await vi.waitFor(() => expect(startSessionTimeoutStep).toHaveBeenCalledOnce());
    expect(createTurnControl).toHaveBeenCalledOnce();
    expect(inbox.claimSessionHook).toHaveBeenCalledWith("eve:session:session-1:inbox");
    sessionCreation.resolve({ history: [], state: {} } as never);

    const boot = await bootPromise;
    expect(boot?.session.initialTurnControl).toBeDefined();
    expect(boot?.session.sessionTimeoutControl).toBeDefined();
    const loopStart = boot!.session.sessionTimeoutControl!.start();
    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
    timeoutStartup.resolve({ runId: "timeout-run-1" });
    await loopStart;
  });

  it("waits for stable and alias ownership before starting the timeout", async () => {
    const stableClaim = deferred<void>();
    const aliasClaim = deferred<void>();
    const inbox = createInbox();
    inbox.claimSessionHook
      .mockImplementationOnce(async () => await stableClaim.promise)
      .mockImplementationOnce(async () => await aliasClaim.promise);
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);

    const bootPromise = bootInitialOwner(
      initialInput({
        serializedContext: {
          "eve.bundle": { source: { kind: "bundled" } },
          "eve.continuationToken": "channel:conversation-1",
        },
      }),
      "session-1",
    );

    await vi.waitFor(() => expect(inbox.claimSessionHook).toHaveBeenCalledTimes(2));
    expect(createTurnControl).not.toHaveBeenCalled();
    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
    stableClaim.resolve();
    await Promise.resolve();
    expect(createTurnControl).not.toHaveBeenCalled();
    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
    aliasClaim.resolve();
    await expect(bootPromise).resolves.toBeDefined();
    expect(createTurnControl).toHaveBeenCalledOnce();
    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
  });

  it("settles an alias conflict without starting a timeout", async () => {
    const inbox = createInbox();
    inbox.claimSessionHook
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ hookConflict: true });
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);
    const continuationConflictCommand = { kind: "reset", reason: "replaced" } as const;

    await expect(
      bootInitialOwner(
        initialInput({
          continuationConflictCommand,
          serializedContext: {
            "eve.bundle": { source: { kind: "bundled" } },
            "eve.continuationToken": "channel:conversation-1",
          },
        }),
        "session-1",
      ),
    ).resolves.toBeUndefined();

    expect(settleContinuationConflictStep).toHaveBeenCalledWith({
      command: continuationConflictCommand,
      continuationToken: "channel:conversation-1",
    });
    expect(createTurnControl).not.toHaveBeenCalled();
    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
    expect(inbox.dispose).toHaveBeenCalledOnce();
  });

  it("cancels a started timeout when session creation fails", async () => {
    const sessionCreation = deferred<never>();
    const inbox = createInbox();
    vi.mocked(createSessionStep).mockReturnValue(sessionCreation.promise);
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);
    const failure = new Error("session creation failed");

    const bootPromise = bootInitialOwner(initialInput(), "session-1");
    await vi.waitFor(() => expect(startSessionTimeoutStep).toHaveBeenCalledOnce());
    sessionCreation.reject(failure);

    await expect(bootPromise).rejects.toBe(failure);
    expect(cancelSessionTimeoutStep).toHaveBeenCalledWith({ runId: "timeout-run-1" });
    expect(vi.mocked(createTurnControl).mock.results[0]?.value.dispose).toHaveBeenCalledOnce();
    expect(inbox.dispose).toHaveBeenCalledOnce();
  });

  it("cancels a started timeout when delegated caller resolution fails", async () => {
    const callerResolution = deferred<never>();
    const inbox = createInbox();
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);
    vi.mocked(hasDelegatedSessionContext).mockReturnValue(true);
    vi.mocked(resolveInitialTurnCallerStep).mockReturnValue(callerResolution.promise);
    const failure = new Error("caller resolution failed");

    const bootPromise = bootInitialOwner(initialInput(), "session-1");
    await vi.waitFor(() => expect(startSessionTimeoutStep).toHaveBeenCalledOnce());
    callerResolution.reject(failure);

    await expect(bootPromise).rejects.toBe(failure);
    expect(cancelSessionTimeoutStep).toHaveBeenCalledWith({ runId: "timeout-run-1" });
    expect(vi.mocked(createTurnControl).mock.results[0]?.value.dispose).toHaveBeenCalledOnce();
    expect(inbox.dispose).toHaveBeenCalledOnce();
  });

  it("carries timeout startup failures into the session loop", async () => {
    const inbox = createInbox();
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);
    const failure = new Error("timeout startup failed");
    vi.mocked(startSessionTimeoutStep).mockRejectedValue(failure);

    const boot = await bootInitialOwner(initialInput(), "session-1");

    await expect(boot?.session.sessionTimeoutControl?.start()).rejects.toBe(failure);
    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
    expect(cancelSessionTimeoutStep).not.toHaveBeenCalled();
    expect(inbox.dispose).not.toHaveBeenCalled();
  });

  it("does not create a timeout when session timeouts are disabled", async () => {
    const inbox = createInbox();
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);

    const boot = await bootInitialOwner(initialInput({ sessionTimeoutMs: false }), "session-1");

    expect(boot?.session.initialTurnControl).toBeDefined();
    expect(boot?.session.sessionTimeoutDeadline).toBeUndefined();
    expect(boot?.session.sessionTimeoutControl).toBeUndefined();
    expect(createTurnControl).toHaveBeenCalledOnce();
    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
  });

  it("does not start a very short timeout until ownership is ready", async () => {
    const ownership = deferred<void>();
    const inbox = createInbox();
    inbox.claimSessionHook.mockImplementationOnce(async () => await ownership.promise);
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);

    const bootPromise = bootInitialOwner(initialInput({ sessionTimeoutMs: 1 }), "session-1");
    await vi.waitFor(() => expect(inbox.claimSessionHook).toHaveBeenCalledOnce());
    expect(createTurnControl).not.toHaveBeenCalled();
    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
    ownership.resolve();

    await expect(bootPromise).resolves.toBeDefined();
    expect(createTurnControl).toHaveBeenCalledOnce();
    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
  });
});
