import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { takeLeadingAppliedRunMessages } from "#execution/session-workflow-tool-run.js";

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

  it("reads a run's relayed messages separately, and takes them a batch's budget at a time", async () => {
    const from = {
      callId: "call",
      input: {},
      runId: "tool-run",
      sequence: 0,
      stepIndex: 0,
      toolName: "review",
      turnId: "turn-1",
    };
    const opened: SessionInboxPayload = {
      from,
      kind: "agent-started",
      session: {
        continuationToken: "subagent:child-1",
        kind: "local",
        name: "reviewer",
        nodeId: "reviewer",
        sessionId: "child-1",
      },
    };
    // Alice's reviewers report long findings, more than one step applies at once.
    const findings = (label: string): SessionInboxPayload => ({
      from,
      kind: "report",
      update: label.padEnd(40_000, "."),
    });
    const batch = {
      kind: "workflow-batch",
      messages: [opened, findings("first"), findings("second")],
    };
    installHooks(
      createMockHook({
        token: "stable",
        reads: [
          Promise.resolve(resolved(batch as never)),
          Promise.resolve(resolved(send("Bob asks how it is going."))),
        ],
      }),
    );
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHook("stable");
    await vi.waitFor(() => expect(inbox.hasPending()).toBe(true));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(takeLeadingAppliedRunMessages(inbox)).toEqual([opened, findings("first")]);
    expect(takeLeadingAppliedRunMessages(inbox)).toEqual([findings("second")]);
    // Taking run messages from the front stops at Bob's message.
    expect(takeLeadingAppliedRunMessages(inbox)).toEqual([]);
    expect(inbox.drain()).toEqual([send("Bob asks how it is going.")]);
    await inbox.dispose();
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

  it("holds every payload behind the handover while interrupts still fire", async () => {
    const handover = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(
      createMockHook({
        reads: [
          Promise.resolve(resolved(send("direct"))),
          Promise.resolve(resolved(runtimeResult)),
          Promise.resolve(resolved(cancel)),
        ],
        token: "stable",
      }),
      createMockHook({
        reads: [handover.promise, Promise.resolve(resolved(finalPart("owner-a:1", 1)))],
        token: "channel",
      }),
    );
    const inbox = createSessionInbox("session-1");
    const delivered = vi.fn();
    inbox.onDelivery(delivered);
    const interrupted = nextInterrupt(inbox);
    const arrived = inbox.whenArrival();
    await inbox.claimSessionHooks(["stable", "channel"], { handover: "owner-a:1" });

    await expect(interrupted).resolves.toEqual(cancel);
    // Arrivals count even while nothing is readable.
    await arrived;
    expect(inbox.awaitingHandover).toBe(true);
    expect(inbox.drain()).toEqual([]);
    expect(inbox.hasPending()).toBe(false);
    expect(delivered).not.toHaveBeenCalled();

    const next = inbox.next();
    handover.resolve(resolved(part("owner-a:1", 0, send("accepted by a"))));
    await expect(next).resolves.toEqual(send("accepted by a"));
    expect(inbox.awaitingHandover).toBe(false);
    expect(inbox.drain()).toEqual([send("direct"), runtimeResult, cancel]);
    expect(delivered.mock.calls).toEqual([[send("accepted by a")], [send("direct")]]);
    await inbox.dispose();
  });

  it("opens on a handover that is the first payload its hook delivers and drops other attempts'", async () => {
    installHooks(
      createMockHook({
        reads: [
          Promise.resolve(resolved(part("owner-a:0", 0, send("stale")))),
          Promise.resolve(resolved(finalPart("owner-a:0", 1))),
          Promise.resolve(resolved(part("owner-a:1", 0, send("accepted by a")))),
          Promise.resolve(resolved(finalPart("owner-a:1", 1))),
          Promise.resolve(resolved(send("direct"))),
        ],
        token: "stable",
      }),
    );
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHooks(["stable"], { handover: "owner-a:1" });

    await expect(readResult(inbox)).resolves.toEqual(resolved(send("accepted by a")));
    await expect(readResult(inbox)).resolves.toEqual(resolved(send("direct")));
    expect(inbox.hasPending()).toBe(false);
    await inbox.dispose();
  });

  it("applies handover parts in index order, once each, and opens only after every part", async () => {
    const first = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(
      createMockHook({
        reads: [
          Promise.resolve(resolved(send("direct"))),
          Promise.resolve(resolved(part("owner-a:1", 1, send("b")))),
          // A retried send step repeats its index.
          Promise.resolve(resolved(part("owner-a:1", 1, send("b")))),
          Promise.resolve(resolved(finalPart("owner-a:1", 2))),
          Promise.resolve(resolved(cancel)),
          first.promise,
        ],
        token: "stable",
      }),
    );
    const inbox = createSessionInbox("session-1");
    const pumped = nextInterrupt(inbox);
    await inbox.claimSessionHooks(["stable"], { handover: "owner-a:1" });
    await pumped;
    // The final part has arrived, but part 0 has not.
    expect(inbox.awaitingHandover).toBe(true);
    expect(inbox.drain()).toEqual([]);

    first.resolve(resolved(part("owner-a:1", 0, send("a"))));

    await vi.waitFor(() => expect(inbox.awaitingHandover).toBe(false));
    expect(inbox.drain()).toEqual([send("a"), send("b"), send("direct"), cancel]);
    await inbox.dispose();
  });

  it("stops waiting for an abandoned handover, ignoring other attempts", async () => {
    installHooks(
      createMockHook({
        reads: [Promise.resolve(resolved(send("direct"))), Promise.resolve(resolved(cancel))],
        token: "stable",
      }),
    );
    const inbox = createSessionInbox("session-1");
    const pumped = nextInterrupt(inbox);
    await inbox.claimSessionHooks(["stable"], { handover: "owner-a:1" });
    await pumped;
    const settled = inbox.whenHandoverSettled();

    inbox.abandonHandover("owner-a:0");
    expect(inbox.awaitingHandover).toBe(true);
    inbox.abandonHandover("owner-a:1");

    await settled;
    expect(inbox.drain()).toEqual([send("direct"), cancel]);
    await inbox.dispose();
  });

  it("takes back a held address on a fresh hook and places the handover after what it had queued", async () => {
    const replaced = createDeferred<IteratorResult<SessionInboxPayload>>();
    const handover = createDeferred<IteratorResult<SessionInboxPayload>>();
    installHooks(
      createMockHook({
        reads: [Promise.resolve(resolved(send("queued before"))), replaced.promise],
        token: "stable",
      }),
      createMockHook({
        reads: [
          Promise.resolve(resolved(send("after"))),
          handover.promise,
          Promise.resolve(resolved(finalPart("owner-a:1", 1))),
        ],
        token: "stable",
      }),
    );
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHook("stable");
    await vi.waitFor(() => expect(inbox.hasPending()).toBe(true));

    await inbox.claimSessionHooks(["stable"], { force: true, handover: "owner-a:1" });
    replaced.reject(forceClaimed("owner-1"));
    handover.resolve(resolved(part("owner-a:1", 0, send("accepted by b"))));

    await vi.waitFor(() => expect(inbox.awaitingHandover).toBe(false));
    expect(inbox.claimedTokens).toEqual(["stable"]);
    expect(inbox.drain()).toEqual([send("queued before"), send("accepted by b"), send("after")]);
    await inbox.dispose();
  });

  it.each([
    {
      name: "every hook taken: resolves, and the gate no longer hides what was queued",
      reads: [forceClaimed("owner-b"), forceClaimed("owner-b")],
      takenOver: "resolved",
    },
    {
      name: "one hook taken: stays pending",
      reads: [forceClaimed("owner-b"), undefined],
      takenOver: "pending",
    },
    {
      name: "a reader failure: rejects as a failure, not a takeover",
      reads: [new Error("reader failed"), undefined],
      takenOver: "rejected",
    },
  ] as const)("reports a takeover once $name", async ({ reads, takenOver }) => {
    const outcomes = reads.map(() => createDeferred<IteratorResult<SessionInboxPayload>>());
    installHooks(
      createMockHook({
        reads: [Promise.resolve(resolved(send("accepted before"))), outcomes[0]!.promise],
        token: "stable",
      }),
      createMockHook({ reads: [outcomes[1]!.promise], token: "channel" }),
    );
    const inbox = createSessionInbox("session-1");
    await inbox.claimSessionHooks(["stable", "channel"], { handover: "owner-a:1" });
    const settled = inbox.whenTakenOver().then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : "rejected"),
    );
    reads.forEach((error, index) => {
      if (error !== undefined) outcomes[index]!.reject(error);
    });

    if (takenOver === "pending") {
      await vi.waitFor(() => expect(inbox.claimedTokens).toEqual(["channel"]));
      expect(inbox.takenOver).toBe(false);
      await inbox.dispose();
      await expect(settled).resolves.toBe("The session inbox was released before a takeover.");
      return;
    }
    await expect(settled).resolves.toBe(takenOver === "rejected" ? "reader failed" : takenOver);
    if (takenOver === "resolved") {
      expect(inbox.takenOver).toBe(true);
      expect(inbox.drain()).toEqual([send("accepted before")]);
    }
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

  it("creates a hook at once and confirms it only after confirmAfter settles, even on failure", async () => {
    const stable = createMockHook({
      reads: [Promise.resolve(resolved(send("early")))],
      token: "stable",
    });
    installHooks(stable);
    const inbox = createSessionInbox("session-1");
    const sessionCreation = Promise.withResolvers<never>();

    const claim = inbox.claimSessionHook("stable", { confirmAfter: sessionCreation.promise });
    expect(createHookMock).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(stable.getConflict).not.toHaveBeenCalled();
    sessionCreation.reject(new Error("session creation failed"));

    await expect(claim).resolves.toBeUndefined();
    expect(stable.getConflict).toHaveBeenCalledOnce();
    await expect(readResult(inbox)).resolves.toEqual(resolved(send("early")));
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
  readonly getConflict: ReturnType<typeof vi.fn>;
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
  const getConflict = vi.fn(async () => input.registration ?? input.conflict ?? null);
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
    getConflict,
    token: input.token,
  });
  return { dispose, getConflict, hook, return: iteratorReturn, token: input.token };
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

const cancel: SessionInboxPayload = { kind: "cancel" };
const runtimeResult: SessionInboxPayload = { kind: "runtime-action-result", results: [] };

function part(attemptKey: string, index: number, ...payloads: SessionInboxPayload[]) {
  return { attemptKey, index, kind: "handover", payloads } as SessionInboxPayload;
}

function finalPart(attemptKey: string, index: number): SessionInboxPayload {
  return { attemptKey, final: true, index, kind: "handover", payloads: [] };
}

function forceClaimed(claimedByRunId: string): Error {
  return Object.assign(new Error("Hook token was force-claimed."), {
    claimedByRunId,
    name: "HookForceClaimedError",
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
