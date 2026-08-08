import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionInboxPayload } from "#execution/session-command-inbox.js";
import { createSessionCommandInbox } from "#execution/session-command-inbox.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

describe("createSessionCommandInbox", () => {
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
    const inbox = createSessionCommandInbox();

    await inbox.claimStable("stable");
    await inbox.rekeyContinuation("channel");

    await expect(inbox.next()).resolves.toEqual(resolved(send("by id")));
    inbox.consumeNext();
    await expect(inbox.next()).resolves.toEqual(resolved({ kind: "clear" }));
    inbox.consumeNext();
    await inbox.dispose();
  });

  it("retains a committed read from the previous alias across rekey", async () => {
    const oldRead = createDeferred<IteratorResult<SessionInboxPayload>>();
    const replacementRead = createDeferred<IteratorResult<SessionInboxPayload>>();
    const stable = createMockHook({ token: "stable" });
    const oldAlias = createMockHook({ reads: [oldRead.promise], token: "old" });
    const replacement = createMockHook({
      reads: [replacementRead.promise],
      token: "replacement",
    });
    installHooks(stable, oldAlias, replacement);
    const inbox = createSessionCommandInbox();

    await inbox.claimStable("stable");
    await inbox.rekeyContinuation("old");
    const pending = inbox.next();
    await inbox.rekeyContinuation("replacement");

    oldRead.resolve(resolved(send("old")));
    await expect(pending).resolves.toEqual(resolved(send("old")));
    inbox.consumeNext();

    replacementRead.resolve(resolved(send("replacement")));
    await expect(inbox.next()).resolves.toEqual(resolved(send("replacement")));
    inbox.consumeNext();
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
    const inbox = createSessionCommandInbox();

    await inbox.claimStable("stable");
    const pending = inbox.next();
    await inbox.rekeyContinuation("channel");

    await expect(pending).resolves.toEqual(resolved(send("anchored")));
    inbox.consumeNext();
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
    const inbox = createSessionCommandInbox();

    await inbox.claimStable("stable");
    await inbox.rekeyContinuation("current");
    await expect(inbox.rekeyContinuation("candidate")).rejects.toMatchObject({
      conflictingRunId: "wrun_owner",
      name: "HookConflictError",
      token: "candidate",
    });

    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(current.dispose).not.toHaveBeenCalled();
    await inbox.dispose();
    expect(current.dispose).toHaveBeenCalledOnce();
  });

  it("never permits the stable session token to change", async () => {
    const stable = createMockHook({ token: "stable" });
    installHooks(stable);
    const inbox = createSessionCommandInbox();

    await inbox.claimStable("stable");
    await inbox.claimStable("stable");
    await expect(inbox.claimStable("different")).rejects.toThrow(
      "A session command inbox cannot change its stable token.",
    );
    expect(createHookMock).toHaveBeenCalledOnce();
    await inbox.dispose();
  });

  it("disposes active hooks without closing pending iterators", async () => {
    const stable = createMockHook({ token: "stable" });
    const alias = createMockHook({ token: "channel" });
    installHooks(stable, alias);
    const inbox = createSessionCommandInbox();

    await inbox.claimStable("stable");
    await inbox.rekeyContinuation("channel");
    void inbox.next();
    await inbox.dispose();
    await inbox.dispose();

    expect(stable.dispose).toHaveBeenCalledOnce();
    expect(alias.dispose).toHaveBeenCalledOnce();
    expect(stable.return).not.toHaveBeenCalled();
    expect(alias.return).not.toHaveBeenCalled();
  });

  it("stashes authorization callbacks while the window is closed", async () => {
    const sessionRead = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(
      createMockHook({ reads: [sessionRead.promise], token: "stable" }),
      createMockHook({
        reads: [Promise.resolve(resolved(authCallback("weather")))],
        token: "session:auth",
      }),
    );
    const inbox = createSessionCommandInbox();
    await inbox.claimStable("stable");
    await inbox.claimAuthorization("session:auth");

    // The callback resolves first, but only session activity surfaces.
    const pending = inbox.nextWithSource();
    sessionRead.resolve(resolved(send("while closed")));
    await expect(pending).resolves.toEqual({
      result: resolved(send("while closed")),
      source: "session",
    });
    inbox.consumeNext();

    inbox.setAuthorizationWindow(true);
    await expect(inbox.nextWithSource()).resolves.toEqual({
      result: resolved(authCallback("weather")),
      source: "authorization",
    });
    inbox.consumeNext();
    inbox.setAuthorizationWindow(false);
    await inbox.dispose();
  });

  it("re-stashes an unconsumed authorization read when the window closes", async () => {
    installHooks(
      createMockHook({ reads: [Promise.resolve(resolved(send("first")))], token: "stable" }),
      createMockHook({
        reads: [Promise.resolve(resolved(authCallback("weather")))],
        token: "session:auth",
      }),
    );
    const inbox = createSessionCommandInbox();
    await inbox.claimStable("stable");
    await inbox.claimAuthorization("session:auth");

    // Window open: the session read arrives first and is offered; the
    // callback read resolves behind it and waits enqueued.
    inbox.setAuthorizationWindow(true);
    await expect(inbox.nextWithSource()).resolves.toEqual({
      result: resolved(send("first")),
      source: "session",
    });
    inbox.setAuthorizationWindow(false);
    inbox.consumeNext();

    // Window closed: the stashed callback never surfaces as session activity.
    const closedRead = inbox.nextWithSource();
    let settled = false;
    void closedRead.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Reopening surfaces the same stashed callback exactly once.
    inbox.setAuthorizationWindow(true);
    await expect(closedRead).resolves.toEqual({
      result: resolved(authCallback("weather")),
      source: "authorization",
    });
    inbox.consumeNext();
    await inbox.dispose();
  });

  it("disposes the authorization hook with the inbox", async () => {
    const auth = createMockHook({ token: "session:auth" });
    installHooks(createMockHook({ token: "stable" }), auth);
    const inbox = createSessionCommandInbox();

    await inbox.claimStable("stable");
    await inbox.claimAuthorization("session:auth");
    await inbox.dispose();

    expect(auth.dispose).toHaveBeenCalledOnce();
    expect(auth.return).not.toHaveBeenCalled();
  });
});

function authCallback(connectionName: string): SessionInboxPayload {
  return {
    kind: "deliver",
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
    getConflict: vi.fn(async () => input.conflict ?? null),
    token: input.token,
  });
  return { dispose, hook, return: iteratorReturn, token: input.token };
}

function installHooks(...hooks: readonly MockHook[]): void {
  const queue = [...hooks];
  createHookMock.mockImplementation((options: { readonly token: string }) => {
    const hook = queue.shift();
    if (hook === undefined || hook.token !== options.token) {
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

function createDeferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
