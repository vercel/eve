import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionInbox,
  type SessionInboxHandle,
  type SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";

async function readResult(inbox: SessionInboxHandle): Promise<IteratorResult<SessionInboxPayload>> {
  const value = await inbox.next();
  return value === undefined ? { done: true, value: undefined } : { done: false, value };
}

/** Resolves with the first interrupt the pump pushes to `onInterrupt`. */
function nextInterrupt(inbox: SessionInboxHandle): Promise<SessionInboxPayload> {
  return new Promise((resolve) => {
    const unsubscribe = inbox.onInterrupt((payload) => {
      unsubscribe();
      resolve(payload);
    });
  });
}

function hookTokens(inbox: SessionInboxHandle): readonly string[] {
  return inbox.claimedTokens;
}

const createHookMock = vi.fn();

vi.mock("#execution/session-inbox/release-step.js", () => ({
  releaseSessionHooksStep: vi.fn(async () => {}),
}));

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
  getWritable: vi.fn(),
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
}));

describe("createSessionInbox", () => {
  it("notifies delivery observers promptly and replays unread deliveries on subscription", async () => {
    const delivery = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(createMockHook({ token: "stable", reads: [delivery.promise] }));
    const inbox = createSessionInbox("session-1");
    const observed = vi.fn();
    const unsubscribe = inbox.onDelivery(observed);
    await inbox.claimSessionHook("stable");
    delivery.resolve(resolved(send("correction")));
    await delivery.promise;
    expect(observed).toHaveBeenCalledWith(send("correction"));
    unsubscribe();
    const lateObserver = vi.fn();
    inbox.onDelivery(lateObserver);
    expect(lateObserver).toHaveBeenCalledWith(send("correction"));
    expect(inbox.drain()).toEqual([send("correction")]);
    await inbox.dispose();
  });
  beforeEach(() => {
    createHookMock.mockReset();
  });

  it("multiplexes the stable session inbox and continuation alias", async () => {
    installHooks(
      createMockHook({ reads: [Promise.resolve(resolved(send("by id")))], token: "stable" }),
      createMockHook({
        reads: [Promise.resolve(resolved({ kind: "clear" }))],
        token: "channel",
      }),
    );
    const inbox = createSessionInbox("session-1");

    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("channel");

    await expect(readResult(inbox)).resolves.toEqual(resolved(send("by id")));
    await expect(readResult(inbox)).resolves.toEqual(resolved({ kind: "clear" }));
    await inbox.dispose();
  });

  it("pushes cancellation to interrupt handlers without consuming messages awaiting a committed boundary", async () => {
    installHooks(
      createMockHook({
        token: "stable",
        reads: [
          Promise.resolve(resolved(send("steer me"))),
          Promise.resolve(resolved({ kind: "cancel", turnId: "turn-1" })),
        ],
      }),
    );
    const inbox = createSessionInbox("session-1");
    const interrupt = nextInterrupt(inbox);
    await inbox.claimSessionHook("stable");
    await expect(interrupt).resolves.toEqual({ kind: "cancel", turnId: "turn-1" });
    expect(inbox.drain()).toEqual([send("steer me"), { kind: "cancel", turnId: "turn-1" }]);
    await inbox.dispose();
  });

  it("retains tool traffic and gated callbacks in the same stable queue", async () => {
    const report: SessionInboxPayload = {
      kind: "report",
      from: {
        callId: "call",
        input: {},
        runId: "tool-run",
        sequence: 0,
        stepIndex: 0,
        taskId: "work-abc234",
        toolName: "work",
        turnId: "turn-1",
      },
      update: "working",
    };
    installHooks(
      createMockHook({
        token: "stable",
        reads: [
          Promise.resolve(resolved(authCallback("weather"))),
          Promise.resolve(resolved(report)),
          Promise.resolve(resolved(send("hello"))),
        ],
      }),
    );
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHook("stable");
    await expect(readResult(inbox)).resolves.toEqual(resolved(authCallback("weather")));
    await expect(readResult(inbox)).resolves.toEqual(resolved(report));
    await expect(readResult(inbox)).resolves.toEqual(resolved(send("hello")));
    expect(inbox.drain()).toEqual([]);
    expect(createHookMock).toHaveBeenCalledOnce();
    expect(await inbox.release()).toEqual([]);
  });

  it("keeps a pushed cancellation queued for the consumer", async () => {
    const input = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(createMockHook({ token: "stable", reads: [input.promise] }));
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHook("stable");
    const interrupt = nextInterrupt(inbox);
    input.resolve(resolved({ kind: "cancel" }));
    await expect(interrupt).resolves.toEqual({ kind: "cancel" });
    expect(inbox.drain()).toEqual([{ kind: "cancel" }]);
    expect(await inbox.release()).toEqual([]);
  });

  it("stops notifying an unsubscribed interrupt handler", async () => {
    const first = createDeferred<IteratorResult<SessionInboxPayload>>();
    const second = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(createMockHook({ token: "stable", reads: [first.promise, second.promise] }));
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHook("stable");
    const handler = vi.fn();
    const unsubscribe = inbox.onInterrupt(handler);
    first.resolve(resolved({ kind: "cancel", turnId: "turn-1" }));
    await first.promise;
    unsubscribe();
    second.resolve(resolved({ kind: "reset" }));
    await second.promise;
    expect(handler).toHaveBeenCalledExactlyOnceWith({ kind: "cancel", turnId: "turn-1" });
    expect(inbox.drain()).toEqual([{ kind: "cancel", turnId: "turn-1" }, { kind: "reset" }]);
    await inbox.dispose();
  });

  it("pumps several messages before the owner reads and drains them exactly once", async () => {
    const first = createDeferred<IteratorResult<SessionInboxPayload>>();
    const second = createDeferred<IteratorResult<SessionInboxPayload>>();
    const third = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(
      createMockHook({ token: "stable", reads: [first.promise, third.promise] }),
      createMockHook({ token: "alias", reads: [second.promise] }),
    );
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("alias");
    first.resolve(resolved(send("first")));
    await first.promise;
    second.resolve(resolved(send("second")));
    await second.promise;
    third.resolve(resolved(send("third")));
    await third.promise;
    expect(inbox.drain()).toEqual([send("first"), send("second"), send("third")]);
    expect(inbox.drain()).toEqual([]);
    expect(await inbox.release()).toEqual([]);
  });

  it("keeps pumping so a cancel behind a burst of unread messages still interrupts", async () => {
    const burst = Array.from({ length: 1500 }, (_, index) =>
      Promise.resolve(resolved(send(`message ${String(index)}`))),
    );
    installHooks(
      createMockHook({
        token: "stable",
        reads: [...burst, Promise.resolve(resolved({ kind: "cancel" }))],
      }),
    );
    const inbox = createSessionInbox("session-1");
    const interrupt = nextInterrupt(inbox);
    await inbox.claimSessionHook("stable");

    await expect(interrupt).resolves.toEqual({ kind: "cancel" });
    expect(inbox.drain()).toHaveLength(1501);
    await inbox.dispose();
  });

  it("surfaces a failed reader instead of silently leaving the owner asleep", async () => {
    const read = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(createMockHook({ token: "stable", reads: [read.promise] }));
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHook("stable");
    const pending = expect(readResult(inbox)).rejects.toThrow("reader failed");
    read.reject(new Error("reader failed"));
    await pending;
    await inbox.dispose();
  });

  it("accounts for an accepted unread command before releasing ownership", async () => {
    installHooks(
      createMockHook({
        reads: [Promise.resolve(resolved(send("during release")))],
        token: "stable",
      }),
    );
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHook("stable");

    await expect(inbox.release()).resolves.toEqual([send("during release")]);
  });

  it("restores released payloads ahead of commands accepted after reclaiming", async () => {
    installHooks(
      createMockHook({ reads: [Promise.resolve(resolved(send("released")))], token: "stable" }),
      createMockHook({
        reads: [Promise.resolve(resolved(send("after reclaim")))],
        token: "stable",
      }),
    );
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHook("stable");
    const released = await inbox.release();
    expect(released).toEqual([send("released")]);

    await inbox.claimSessionHook("stable");
    await vi.waitFor(() => expect(inbox.hasPending()).toBe(true));
    inbox.restore([...released, send("second released")]);

    expect(inbox.drain()).toEqual([
      send("released"),
      send("second released"),
      send("after reclaim"),
    ]);
    await inbox.dispose();
  });

  it("keeps every continuation alias active after later claims", async () => {
    const oldRead = createDeferred<IteratorResult<SessionInboxPayload>>();
    const replacementRead = createDeferred<IteratorResult<SessionInboxPayload>>();
    const stable = createMockHook({ token: "stable" });
    const oldAlias = createMockHook({ reads: [oldRead.promise], token: "old" });
    const replacement = createMockHook({
      reads: [replacementRead.promise],
      token: "replacement",
    });
    installHooks(stable, oldAlias, replacement);
    const inbox = createSessionInbox("session-1");

    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("old");
    const pending = readResult(inbox);
    await inbox.claimSessionHook("replacement");

    oldRead.resolve(resolved(send("old")));
    await expect(pending).resolves.toEqual(resolved(send("old")));

    replacementRead.resolve(resolved(send("replacement")));
    await expect(readResult(inbox)).resolves.toEqual(resolved(send("replacement")));
    await inbox.dispose();

    expect(stable.dispose).toHaveBeenCalledOnce();
    expect(oldAlias.dispose).toHaveBeenCalledOnce();
    expect(replacement.dispose).toHaveBeenCalledOnce();
  });

  it("adds a first continuation alias to an existing stable wait", async () => {
    installHooks(
      createMockHook({ token: "stable" }),
      createMockHook({
        reads: [Promise.resolve(resolved(send("anchored")))],
        token: "channel",
      }),
    );
    const inbox = createSessionInbox("session-1");

    await inbox.claimSessionHook("stable");
    const pending = readResult(inbox);
    await inbox.claimSessionHook("channel");

    await expect(pending).resolves.toEqual(resolved(send("anchored")));
    await inbox.dispose();
  });

  it("disposes a conflicting continuation candidate without releasing current ownership", async () => {
    const stable = createMockHook({ token: "stable" });
    const current = createMockHook({ token: "current" });
    const candidate = createMockHook({
      conflict: { runId: "wrun_owner" },
      token: "candidate",
    });
    installHooks(stable, current, candidate);
    const inbox = createSessionInbox("session-1");

    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("current");
    await expect(inbox.claimSessionHook("candidate")).rejects.toMatchObject({
      conflictingRunId: "wrun_owner",
      name: "HookConflictError",
      token: "candidate",
    });

    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(current.dispose).not.toHaveBeenCalled();
    await inbox.dispose();
    expect(current.dispose).toHaveBeenCalledOnce();
  });

  it("deduplicates session hooks and preserves their claim order", async () => {
    const stable = createMockHook({ token: "stable" });
    const channel = createMockHook({ token: "channel" });
    installHooks(stable, channel);
    const inbox = createSessionInbox("session-1");

    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("channel");
    expect(hookTokens(inbox)).toEqual(["stable", "channel"]);
    expect(createHookMock).toHaveBeenCalledTimes(2);
    expect(createHookMock).toHaveBeenCalledWith({
      metadata: { sessionId: "session-1" },
      token: sessionInboxHookToken("stable"),
    });
    await inbox.dispose();
  });

  it("waits for registration when two callers claim the same address", async () => {
    const registration = Promise.withResolvers<null>();
    installHooks(createMockHook({ token: "stable", registration: registration.promise }));
    const inbox = createSessionInbox("session-1");
    const first = inbox.claimSessionHook("stable");
    let secondSettled = false;
    const second = inbox.claimSessionHook("stable").then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    registration.resolve(null);
    await Promise.all([first, second]);
    expect(createHookMock).toHaveBeenCalledOnce();
    await inbox.dispose();
  });

  it("rejects empty tokens", async () => {
    installHooks(createMockHook({ token: "stable" }), createMockHook({ token: "auth" }));
    const inbox = createSessionInbox("session-1");
    await expect(inbox.claimSessionHook("")).rejects.toThrow("nonempty");
    await inbox.claimSessionHook("stable");
    await inbox.dispose();
  });

  it("bounds the address set without charging repeated claims", async () => {
    const tokens = Array.from({ length: 256 }, (_, index) => `token-${index}`);
    installHooks(...tokens.map((token) => createMockHook({ token })));
    const inbox = createSessionInbox("session-1");
    for (const token of tokens) await inbox.claimSessionHook(token);
    await inbox.claimSessionHook(tokens[0]!);
    await expect(inbox.claimSessionHook("one-too-many")).rejects.toThrow("at most 256");
    expect(hookTokens(inbox)).toEqual(tokens);
    await inbox.dispose();
  });

  it("disposes active hooks without closing pending iterators", async () => {
    const stable = createMockHook({ token: "stable" });
    const alias = createMockHook({ token: "channel" });
    installHooks(stable, alias);
    const inbox = createSessionInbox("session-1");

    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("channel");
    void inbox.next();
    await inbox.dispose();
    await inbox.dispose();

    expect(stable.dispose).toHaveBeenCalledOnce();
    expect(alias.dispose).toHaveBeenCalledOnce();
    expect(stable.return).not.toHaveBeenCalled();
    expect(alias.return).not.toHaveBeenCalled();
  });

  it("disposes every alias with the inbox", async () => {
    const auth = createMockHook({ token: "alias" });
    installHooks(createMockHook({ token: "stable" }), auth);
    const inbox = createSessionInbox("session-1");

    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("alias");
    await inbox.dispose();

    expect(auth.dispose).toHaveBeenCalledOnce();
    expect(auth.return).not.toHaveBeenCalled();
  });
});

function authCallback(connectionName: string): SessionInboxPayload {
  return {
    kind: "authorization-callback",
    payloads: [
      {
        authorizationCallback: {
          callback: { method: "GET", params: { code: "abc" } },
          connectionName,
        },
      },
    ],
  };
}

interface MockHook {
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly hook: unknown;
  readonly return: ReturnType<typeof vi.fn>;
  readonly token: string;
}

function createMockHook(input: {
  readonly registration?: Promise<null>;
  readonly conflict?: { readonly runId: string } | null;
  readonly reads?: readonly Promise<IteratorResult<SessionInboxPayload>>[];
  readonly token: string;
}): MockHook {
  const reads = [...(input.reads ?? [])];
  const dispose = vi.fn();
  const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }) as const);
  const hook = Object.assign(new Promise<SessionInboxPayload>(() => {}), {
    [Symbol.asyncIterator]() {
      return {
        next: vi.fn(
          () =>
            reads.shift() ??
            new Promise<IteratorResult<SessionInboxPayload>>(() => {
              // Intentionally pending.
            }),
        ),
        return: iteratorReturn,
      };
    },
    dispose,
    getConflict: vi.fn(async () => input.registration ?? input.conflict ?? null),
    token: input.token,
  });
  return { dispose, hook, return: iteratorReturn, token: input.token };
}

function installHooks(...hooks: readonly MockHook[]): void {
  const queue = [...hooks];
  createHookMock.mockImplementation((options: { readonly token: string }) => {
    const hook = queue.shift();
    if (hook === undefined || sessionInboxHookToken(hook.token) !== options.token) {
      throw new Error(`Unexpected hook token "${options.token}".`);
    }
    return hook.hook;
  });
}

function send(message: string): SessionInboxPayload {
  return { kind: "send", payload: { message } };
}

function resolved(value: SessionInboxPayload): IteratorResult<SessionInboxPayload> {
  return { done: false, value };
}

function createDeferred<T>() {
  return Promise.withResolvers<T>();
}
