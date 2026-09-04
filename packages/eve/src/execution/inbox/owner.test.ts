import { describe, expect, it, vi } from "vitest";
import { InboxClosedError, ownerInboxFromHook } from "#execution/inbox/owner.js";
import type { InboxEnvelope } from "#execution/inbox/types.js";

function fixture(conflict: { runId: string } | null = null) {
  let deliver: ((value: IteratorResult<InboxEnvelope>) => void) | undefined;
  const next = vi.fn(
    () =>
      new Promise<IteratorResult<InboxEnvelope>>((resolve) => {
        deliver = resolve;
      }),
  );
  const disposed = vi.fn();
  const getConflict = vi.fn(async () => {
    expect(next).toHaveBeenCalledOnce();
    return conflict;
  });
  const hook = {
    token: "owner",
    getConflict,
    dispose: disposed,
    [Symbol.asyncIterator]: () => ({ next }),
  };
  const inbox = ownerInboxFromHook({ ownerRunId: "run", token: "owner" }, hook);
  return {
    inbox,
    disposed,
    getConflict,
    async send(envelope: InboxEnvelope) {
      deliver!({ done: false, value: envelope });
      await Promise.resolve();
    },
  };
}

const event = (
  eventId: string,
  kind = "session.submit",
  payload: unknown = eventId,
): InboxEnvelope => ({ eventId, kind, payload });

describe("OwnerInbox", () => {
  it("starts one reader before claiming and buffers while foreground work runs", async () => {
    const { inbox, send } = fixture();
    expect(await inbox.claim()).toEqual({ kind: "owned" });
    await send(event("one"));
    await send(event("two"));
    expect(inbox.drain().map((item) => item.eventId)).toEqual(["one", "two"]);
    await inbox.dispose();
  });

  it("correlates overlapping questions without stealing unrelated traffic", async () => {
    const { inbox, send } = fixture();
    await inbox.claim();
    const first = inbox.response("first");
    const second = inbox.response("second");
    await send({ ...event("answer-second", "tool.response", "B"), requestId: "second" });
    await send(event("steer"));
    await send({ ...event("answer-first", "tool.response", "A"), requestId: "first" });
    expect((await first).payload).toBe("A");
    expect((await second).payload).toBe("B");
    expect(inbox.drain().map((item) => item.eventId)).toEqual(["steer"]);
    await inbox.dispose();
  });

  it("buffers a reply that arrives before its waiter and rejects stale owners", async () => {
    const { inbox, send } = fixture();
    await inbox.claim();
    await send({
      ...event("stale", "tool.response"),
      requestId: "question",
      target: { ownerRunId: "old-run" },
    });
    await send({
      ...event("answer", "tool.response", "yes"),
      requestId: "question",
      target: { ownerRunId: "run" },
    });
    expect((await inbox.response("question")).payload).toBe("yes");
    expect(inbox.drain()).toEqual([]);
    await inbox.dispose();
  });

  it("observes cancellation during foreground work and delivers it once to the reducer", async () => {
    const { inbox, send } = fixture();
    const observed = vi.fn();
    inbox.observe(observed);
    await inbox.claim();
    await send(event("cancel", "tool.cancel"));
    await send(event("cancel", "tool.cancel"));
    expect(observed).toHaveBeenCalledOnce();
    expect(inbox.drain()).toHaveLength(1);
    await inbox.dispose();
  });

  it("requires a new inbox for a new claim attempt", async () => {
    const { inbox, disposed } = fixture({ runId: "winner" });
    expect(await inbox.claim()).toEqual({ kind: "conflict", runId: "winner" });
    await expect(inbox.claim()).rejects.toThrow("exactly one claim attempt");
    await inbox.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("rejects pending request and event waits on disposal", async () => {
    const { inbox } = fixture();
    await inbox.claim();
    const eventResult = expect(inbox.next()).rejects.toBeInstanceOf(InboxClosedError);
    const responseResult = expect(inbox.response("pending")).rejects.toBeInstanceOf(
      InboxClosedError,
    );
    await inbox.dispose();
    await Promise.all([eventResult, responseResult]);
  });
  it("aborts one correlated waiter without closing other requests or the owner", async () => {
    const { inbox, send } = fixture();
    await inbox.claim();
    const signal = new AbortController();
    const cancelled = expect(inbox.response("cancelled", signal.signal)).rejects.toThrow(
      "cancelled ask",
    );
    const retained = inbox.response("retained");
    signal.abort(new Error("cancelled ask"));
    await cancelled;
    await send({ ...event("retained-reply", "tool.response", "answer"), requestId: "retained" });
    expect((await retained).payload).toBe("answer");
    await send(event("still-owned"));
    expect(inbox.drain()).toEqual([event("still-owned")]);
    await inbox.dispose();
  });

  it("notifies the foreground owner when its reader fails", async () => {
    const { inbox, send } = fixture();
    const failure = vi.fn();
    inbox.observe(() => {}, failure);
    await inbox.claim();
    await send({ eventId: "", kind: "invalid", payload: {} });
    expect(failure).toHaveBeenCalledWith(expect.any(TypeError));
    expect(() => inbox.drain()).toThrow("eventId");
    await inbox.dispose();
    expect(failure).toHaveBeenCalledOnce();
  });
});
