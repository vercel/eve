import { beforeEach, describe, expect, it, vi } from "vitest";

import { workflowOwnerPorts } from "#execution/session/entry.js";
import { bootInitialOwner } from "#execution/session/owner-boot.js";
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

function subagentInput(overrides: Record<string, unknown> = {}) {
  return initialInput({
    ...overrides,
    serializedContext: {
      "eve.bundle": { nodeId: "child", source: { kind: "bundled" } },
      ...(overrides.serializedContext as Record<string, unknown> | undefined),
    },
  });
}

function createInbox() {
  return {
    claimSessionHook: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  it("preserves the authenticated creator on the first delivery", async () => {
    vi.mocked(createSessionInbox).mockReturnValue(createInbox() as never);
    const auth = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    const boot = await bootInitialOwner(
      initialInput({
        serializedContext: { "eve.auth": auth, "eve.bundle": { source: { kind: "bundled" } } },
      }),
      "session-1",
      workflowOwnerPorts("session-1"),
    );
    expect(boot?.session.start.kind).toBe("turn");
    expect(
      boot?.session.start.kind === "turn" ? boot.session.start.input?.auth : undefined,
    ).toEqual(auth);
  });

  it("creates a local subagent session and resolves its caller in the workflow body without boot steps", async () => {
    const inbox = createInbox();
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);
    vi.mocked(hasDelegatedSessionContext).mockReturnValue(true);

    const boot = await bootInitialOwner(
      subagentInput({
        serializedContext: {
          "eve.bundle": { nodeId: "subagents/researcher", source: { kind: "bundled" } },
          "eve.channel": {
            kind: "subagent",
            state: {
              callId: "call-1",
              parentContinuationToken: "parent-reply-hook",
              parentSessionId: "parent-1",
              subagentName: "researcher",
            },
          },
        },
      }),
      "session-1",
      workflowOwnerPorts("session-1"),
    );

    expect(resolveInitialTurnCallerStep).not.toHaveBeenCalled();
    expect(inbox.claimSessionHook).toHaveBeenCalledOnce();
    expect(createTurnControl).toHaveBeenCalledOnce();
    expect(boot?.session.initialTurnControl).toBeDefined();
    expect(boot?.session.caller).toEqual({
      callId: "call-1",
      replyTo: { kind: "hook", token: "parent-reply-hook" },
      subagentName: "researcher",
    });
    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
    await boot!.session.sessionTimeoutControl!.start();
    expect(startSessionTimeoutStep).toHaveBeenCalledOnce();
  });

  it("creates a root session in the workflow body, without a step", async () => {
    const inbox = createInbox();
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);

    const boot = await bootInitialOwner(
      initialInput({ input: { message: "hello", outputSchema: { type: "object" } } }),
      "session-1",
      workflowOwnerPorts("session-1"),
    );

    expect(boot?.session.history).toEqual([]);
    expect(boot?.session.sessionState).toMatchObject({
      hasProxyInputRequests: false,
      sessionId: "session-1",
      snapshot: { session: { outputSchema: { type: "object" }, sessionId: "session-1" } },
    });
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
      workflowOwnerPorts("session-1"),
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
        workflowOwnerPorts("session-1"),
      ),
    ).resolves.toBeUndefined();

    expect(settleContinuationConflictStep).toHaveBeenCalledWith({
      command: continuationConflictCommand,
      continuationToken: "channel:conversation-1",
    });
    expect(inbox.dispose).toHaveBeenCalledOnce();
  });

  it("fails the session and releases the inbox when remote callback caller resolution fails", async () => {
    const inbox = createInbox();
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);
    const failure = new Error("boot failed");
    vi.mocked(resolveInitialTurnCallerStep).mockRejectedValue(failure);

    await expect(
      bootInitialOwner(
        subagentInput({
          serializedContext: {
            "eve.bundle": { nodeId: "subagents/researcher", source: { kind: "bundled" } },
            "eve.sessionCallback": {
              callId: "call-1",
              subagentName: "researcher",
              token: "tok",
              url: "https://example.com/cb",
            },
          },
        }),
        "session-1",
        workflowOwnerPorts("session-1"),
      ),
    ).rejects.toBe(failure);
    expect(mocks.failSession).toHaveBeenCalledOnce();
    expect(inbox.dispose).toHaveBeenCalledOnce();
  });

  it("does not create a timeout when session timeouts are disabled", async () => {
    const inbox = createInbox();
    vi.mocked(createSessionInbox).mockReturnValue(inbox as never);

    const boot = await bootInitialOwner(
      initialInput({ sessionTimeoutMs: false }),
      "session-1",
      workflowOwnerPorts("session-1"),
    );

    expect(boot?.session.initialTurnControl).toBeDefined();
    expect(boot?.session.sessionTimeoutControl).toBeUndefined();
    expect(createTurnControl).toHaveBeenCalledOnce();
    expect(startSessionTimeoutStep).not.toHaveBeenCalled();
  });
});
