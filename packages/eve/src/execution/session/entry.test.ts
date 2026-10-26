import { beforeEach, describe, expect, it, vi } from "vitest";

import { bootInitialOwner } from "#execution/session/entry.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { startSessionTimeoutStep } from "#execution/session/timeout-steps.js";
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
  vi.mocked(createTurnControl).mockImplementation(() => ({
    cancellation: new AbortController(),
    steering: new AbortController(),
  }));
  vi.mocked(resolveInitialTurnCallerStep).mockResolvedValue(undefined);
  vi.mocked(hasDelegatedSessionContext).mockReturnValue(false);
  vi.mocked(settleContinuationConflictStep).mockResolvedValue(undefined);
});

describe("bootInitialOwner", () => {
  it("prepares turn controls and claims while session creation is pending, confirming after it", async () => {
    const sessionCreation = deferred<never>();
    const inbox = createInbox();
    vi.mocked(createSessionStep).mockReturnValue(sessionCreation.promise);
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);

    const bootPromise = bootInitialOwner(initialInput(), "session-1");

    await vi.waitFor(() => expect(inbox.claimSessionHook).toHaveBeenCalledOnce());
    expect(inbox.claimSessionHook).toHaveBeenCalledWith("eve:session:session-1:inbox", {
      confirmAfter: sessionCreation.promise,
    });
    expect(createTurnControl).toHaveBeenCalledOnce();
    sessionCreation.resolve({ history: [], state: {} } as never);

    const boot = await bootPromise;
    expect(boot?.session.initialTurnControl).toBeDefined();
    // The session loop starts the timer, once ownership is confirmed.
    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
    await boot!.session.sessionTimeoutControl!.start();
    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
  });

  it("waits for stable and alias ownership before returning", async () => {
    const stableClaim = deferred<void>();
    const aliasClaim = deferred<void>();
    const inbox = createInbox();
    inbox.claimSessionHook
      .mockImplementationOnce(async () => await stableClaim.promise)
      .mockImplementationOnce(async () => await aliasClaim.promise);
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);
    let booted = false;

    const bootPromise = bootInitialOwner(
      initialInput({
        serializedContext: {
          "eve.bundle": { source: { kind: "bundled" } },
          "eve.continuationToken": "channel:conversation-1",
        },
      }),
      "session-1",
    ).then((boot) => {
      booted = true;
      return boot;
    });

    await vi.waitFor(() => expect(inbox.claimSessionHook).toHaveBeenCalledTimes(2));
    stableClaim.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(booted).toBe(false);
    aliasClaim.resolve();
    await expect(bootPromise).resolves.toBeDefined();
  });

  it("settles an alias conflict and releases the inbox", async () => {
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
    expect(inbox.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    {
      fail: (failure: Error) => vi.mocked(createSessionStep).mockRejectedValue(failure),
      source: "session creation",
    },
    {
      fail: (failure: Error) => {
        vi.mocked(hasDelegatedSessionContext).mockReturnValue(true);
        vi.mocked(resolveInitialTurnCallerStep).mockRejectedValue(failure);
      },
      source: "delegated caller resolution",
    },
  ])("fails the session and releases the inbox when $source fails", async ({ fail }) => {
    const inbox = createInbox();
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);
    const failure = new Error("boot failed");
    fail(failure);

    await expect(bootInitialOwner(initialInput(), "session-1")).rejects.toBe(failure);
    expect(mocks.failSession).toHaveBeenCalledOnce();
    expect(inbox.dispose).toHaveBeenCalledOnce();
  });

  it("does not create a timeout when session timeouts are disabled", async () => {
    const inbox = createInbox();
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);

    const boot = await bootInitialOwner(initialInput({ sessionTimeoutMs: false }), "session-1");

    expect(boot?.session.initialTurnControl).toBeDefined();
    expect(boot?.session.sessionTimeoutControl).toBeUndefined();
    expect(createTurnControl).toHaveBeenCalledOnce();
    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
  });
});
