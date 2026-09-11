import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionCommandInbox,
  type SessionInboxPayload,
} from "#execution/session-command-inbox.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
  getWritable: vi.fn(),
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
    const inbox = createSessionCommandInbox("session-1");

    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("channel");

    await expect(inbox.next()).resolves.toEqual(resolved(send("by id")));
    inbox.consumeNext();
    await expect(inbox.next()).resolves.toEqual(resolved({ kind: "clear" }));
    inbox.consumeNext();
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
    const inbox = createSessionCommandInbox("session-1");
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

  it("surfaces a failed reader instead of silently leaving the owner asleep", async () => {
    const read = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(createMockHook({ token: "stable", reads: [read.promise] }));
    const inbox = createSessionCommandInbox("session-1");
    await inbox.claimSessionHook("stable");
    const pending = expect(inbox.next()).rejects.toThrow("reader failed");
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
    const inbox = createSessionCommandInbox("session-1");
    await inbox.claimSessionHook("stable");

    await expect(inbox.release()).resolves.toEqual([send("during release")]);
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
    const inbox = createSessionCommandInbox("session-1");

    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("old");
    const pending = inbox.next();
    await inbox.claimSessionHook("replacement");

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
    const inbox = createSessionCommandInbox("session-1");

    await inbox.claimSessionHook("stable");
    const pending = inbox.next();
    await inbox.claimSessionHook("channel");

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
    const inbox = createSessionCommandInbox("session-1");

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
    const inbox = createSessionCommandInbox("session-1");

    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("stable");
    await inbox.claimSessionHook("channel");
    expect(inbox.sessionHookTokens).toEqual(["stable", "channel"]);
    expect(createHookMock).toHaveBeenCalledTimes(2);
    expect(createHookMock).toHaveBeenCalledWith({
      metadata: { sessionId: "session-1" },
      token: "stable",
    });
    await inbox.dispose();
  });

  it("rejects empty tokens and overlapping session and authorization addresses", async () => {
    installHooks(createMockHook({ token: "stable" }), createMockHook({ token: "auth" }));
    const inbox = createSessionCommandInbox("session-1");
    await expect(inbox.claimSessionHook("")).rejects.toThrow("nonempty");
    await inbox.claimSessionHook("stable");
    await expect(inbox.claimAuthorization("stable")).rejects.toThrow("cannot share");
    await inbox.claimAuthorization("auth");
    await expect(inbox.claimSessionHook("auth")).rejects.toThrow("cannot share");
    await inbox.dispose();
  });

  it("bounds the address set without charging repeated claims", async () => {
    const tokens = Array.from({ length: 256 }, (_, index) => `token-${index}`);
    installHooks(...tokens.map((token) => createMockHook({ token })));
    const inbox = createSessionCommandInbox("session-1");
    for (const token of tokens) await inbox.claimSessionHook(token);
    await inbox.claimSessionHook(tokens[0]!);
    await expect(inbox.claimSessionHook("one-too-many")).rejects.toThrow("at most 256");
    expect(inbox.sessionHookTokens).toEqual(tokens);
    await inbox.dispose();
  });

  it("disposes active hooks without closing pending iterators", async () => {
    const stable = createMockHook({ token: "stable" });
    const alias = createMockHook({ token: "channel" });
    installHooks(stable, alias);
    const inbox = createSessionCommandInbox("session-1");

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

  it("stashes authorization callbacks while the window is closed", async () => {
    const sessionRead = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(
      createMockHook({ reads: [sessionRead.promise], token: "stable" }),
      createMockHook({
        reads: [Promise.resolve(resolved(authCallback("weather")))],
        token: "session:auth",
      }),
    );
    const inbox = createSessionCommandInbox("session-1");
    await inbox.claimSessionHook("stable");
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
    const inbox = createSessionCommandInbox("session-1");
    await inbox.claimSessionHook("stable");
    await inbox.claimAuthorization("session:auth");

    // Window open: the session read arrives first and is offered; the
    // callback read resolves behind it and waits enqueued.
    inbox.setAuthorizationWindow(true);
    await expect(inbox.nextWithSource()).resolves.toEqual({
      result: resolved(send("first")),
      source: "session",
    });
    expect(inbox.hasReadyAuthorization()).toBe(false);
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

  it("lets an older callback supersede an unconsumed offered session read", async () => {
    const sessionRead = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(
      createMockHook({ reads: [sessionRead.promise], token: "stable" }),
      createMockHook({
        reads: [Promise.resolve(resolved(authCallback("weather")))],
        token: "session:auth",
      }),
    );
    const inbox = createSessionCommandInbox("session-1");
    await inbox.claimSessionHook("stable");
    await inbox.claimAuthorization("session:auth");

    const losingRead = inbox.nextWithSource();
    await Promise.resolve();
    sessionRead.resolve(resolved(send("later session read")));
    await expect(losingRead).resolves.toEqual({
      result: resolved(send("later session read")),
      source: "session",
    });

    inbox.setAuthorizationWindow(true);
    expect(inbox.hasReadyAuthorization()).toBe(true);
    await expect(inbox.nextWithSource()).resolves.toEqual({
      result: resolved(authCallback("weather")),
      source: "authorization",
    });
    inbox.consumeNext();
    inbox.setAuthorizationWindow(false);

    await expect(inbox.nextWithSource()).resolves.toEqual({
      result: resolved(send("later session read")),
      source: "session",
    });
    inbox.consumeNext();
    await inbox.dispose();
  });

  it("disposes the authorization hook with the inbox", async () => {
    const auth = createMockHook({ token: "session:auth" });
    installHooks(createMockHook({ token: "stable" }), auth);
    const inbox = createSessionCommandInbox("session-1");

    await inbox.claimSessionHook("stable");
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

function createDeferred<T>() {
  return Promise.withResolvers<T>();
}
