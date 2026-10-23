import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "#client/session-store.js";
import type {
  AgentObservation,
  ConversationState,
  FollowAgents,
} from "#client/conversation-state.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { eventsOfLine, linesOf } from "#protocol/session-lines.js";
import {
  EVE_OBSERVATION_KEY_HEADER,
  localObservationKey,
} from "#protocol/descendant-observation.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/session-http.js";
import { testTurnFacts } from "#internal/testing/events.js";
import { position } from "#protocol/session-projection/public-view.js";

const at = "2026-10-10T00:00:00.000Z";
const scopes: (() => void)[] = [];
afterEach(() => {
  scopes.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function opening(id: string, task = false): SessionEvent {
  return {
    type: "child.opened",
    data: {
      sessionId: id,
      name: id,
      owner: task ? { taskId: `task_${id}` } : { callId: `call_${id}` },
      stream: `/eve/v1/session/${id}/stream`,
    },
  };
}
function prefix(events: readonly SessionEvent[]) {
  return linesOf(events, at).flatMap((line, index) => eventsOfLine(line, index, at));
}
function conversation(observation: AgentObservation): ConversationState {
  if (observation.status === "not-followed" || observation.conversation === undefined)
    throw new Error("No observation");
  return observation.conversation;
}
function fixture(root: readonly SessionEvent[], followAgents: FollowAgents = true) {
  const logs = new Map<string, StoredLine[]>();
  const denied = new Map<string, number>();
  const keys = new Map<string, string>();
  const stalled = new Set<string>();
  const requests: { id: string; cursor: number; signal: AbortSignal | null | undefined }[] = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = new URL(String(request));
    expect(url.origin).toBe("https://eve.test");
    expect(init?.redirect).toBe("error");
    const path = (JSON.parse(url.searchParams.get("children")!) as { sessionId: string }[]).map(
      (hop) => hop.sessionId,
    );
    const id = path.at(-1)!;
    const cursor = Number(url.searchParams.get("startIndex") ?? 0);
    requests.push({ id, cursor, signal: init?.signal });
    if (denied.has(id)) return Response.json({ error: "Unavailable" }, { status: denied.get(id) });
    expect(url.searchParams.get("follow")).toBe("false");
    const lines = logs.get(JSON.stringify(path)) ?? logs.get(id) ?? [];
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              lines
                .slice(cursor)
                .map((line) => JSON.stringify(line) + "\n")
                .join(""),
            ),
          );
          if (!stalled.has(id)) controller.close();
          else
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
              once: true,
            });
        },
      }),
      {
        headers: {
          [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
          [EVE_STREAM_TAIL_INDEX_HEADER]: String(
            stalled.has(id) ? lines.length + 1 : lines.length - 1,
          ),
          [EVE_OBSERVATION_KEY_HEADER]:
            keys.get(JSON.stringify(path)) ?? keys.get(id) ?? localObservationKey(id),
        },
      },
    );
  });
  const store = new SessionStore({
    baseUrl: "https://eve.test",
    initialSession: { sessionId: "root", streamIndex: 0 },
    initialEvents: prefix(root),
    followAgents,
  });
  const start = () => {
    const stop = store.observe();
    scopes.push(stop);
    return stop;
  };
  return { store, logs, denied, keys, stalled, requests, fetcher, start };
}

describe("recursive child observations", () => {
  it.each([true, () => true])(
    "follows workflow and task-owned descendants with the same policy: %s",
    async (policy) => {
      const f = fixture([opening("desk")], policy);
      f.logs.set("desk", linesOf([opening("reviewer", true)], at));
      f.logs.set(
        "reviewer",
        linesOf([...testTurnFacts(0, "Reviewed.", ["review"]), opening("query")], at),
      );
      f.logs.set("query", linesOf(testTurnFacts(0, "Evidence.", ["query"]), at));
      const callbacks = { onEvent: vi.fn(), onFinish: vi.fn(), onError: vi.fn() };
      f.store.setCallbacks(callbacks);
      expect(f.requests).toHaveLength(0);
      f.start();
      await vi.waitFor(() => expect(f.requests).toHaveLength(3));
      await vi.waitFor(() => {
        const desk = conversation(f.store.snapshot.agents.desk!.observation);
        const reviewer = conversation(desk.agents.reviewer!.observation);
        const query = reviewer.agents.query!.observation;
        expect(query).toMatchObject({ status: "idle", position: 1, caughtUp: true });
        expect(conversation(query).messages.at(-1)?.parts).toContainEqual(
          expect.objectContaining({ type: "text", text: "Evidence." }),
        );
        expect(desk.agents.reviewer).toMatchObject({
          owner: { taskId: "task_reviewer" },
          taskId: "task_reviewer",
        });
      });
      expect(callbacks.onEvent).not.toHaveBeenCalled();
      expect(callbacks.onFinish).not.toHaveBeenCalled();
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(f.store.snapshot.events).toEqual(prefix([opening("desk")]));
    },
  );

  it("selects each relationship once, retains exclusions, and does not traverse excluded children", async () => {
    const policy = vi.fn(({ depth }: { depth: number }) => depth === 1);
    const f = fixture([opening("desk")], policy);
    f.logs.set("desk", linesOf([opening("reviewer")], at));
    const stop = f.start();
    await vi.waitFor(() =>
      expect(
        conversation(f.store.snapshot.agents.desk!.observation).agents.reviewer?.observation,
      ).toEqual({ status: "not-followed", reason: "predicate" }),
    );
    stop();
    f.start();
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(policy.mock.calls.map(([child]) => child.depth)).toEqual([1, 2]);
    expect(f.requests.map((read) => read.id)).toEqual(["desk", "desk"]);
  });

  it.each([false, undefined])("does no following unless opted in: %s", async (policy) => {
    const f = fixture([opening("desk")], false);
    // Also exercise the constructor's omitted default, rather than the fixture default.
    const current =
      policy === undefined
        ? new SessionStore({ initialEvents: prefix([opening("desk")]) })
        : f.store;
    scopes.push(current.observe());
    await Promise.resolve();
    expect(f.requests).toHaveLength(0);
    expect(current.snapshot.agents.desk?.observation.status).toBe("not-followed");
  });

  it("bounds admission and depth without losing the recorded relationships", async () => {
    const f = fixture(Array.from({ length: 129 }, (_, i) => opening(`child_${i}`)));
    f.start();
    expect(f.store.snapshot.agents.child_128?.observation).toEqual({
      status: "not-followed",
      reason: "session-limit",
    });
    await vi.waitFor(() => expect(f.requests).toHaveLength(128));
    expect(f.requests.some((request) => request.id === "child_128")).toBe(false);
    const deep = fixture([opening("level_1")]);
    for (let depth = 1; depth <= 8; depth++)
      deep.logs.set(`level_${depth}`, linesOf([opening(`level_${depth + 1}`)], at));
    deep.start();
    await vi.waitFor(() => expect(deep.requests).toHaveLength(8));
    let state: ConversationState = deep.store.snapshot;
    for (let depth = 1; depth <= 8; depth++)
      state = conversation(state.agents[`level_${depth}`]!.observation);
    expect(state.agents.level_9?.observation).toEqual({
      status: "not-followed",
      reason: "depth-limit",
    });
  });

  it("rotates stalled reads so the ninth child is served without exceeding eight requests", async () => {
    vi.useFakeTimers();
    const f = fixture(Array.from({ length: 9 }, (_, i) => opening(`child_${i}`)));
    for (let i = 0; i < 8; i++) f.stalled.add(`child_${i}`);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(8);
    expect(f.store.snapshot.agents.child_8?.observation.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.requests.some((request) => request.id === "child_8")).toBe(true);
    expect(f.requests.filter((request) => !request.signal?.aborted).length).toBeLessThanOrEqual(8);
  });

  it("enriches a caught-up prefix on later reads, preserving old snapshots and isolating denial", async () => {
    vi.useFakeTimers();
    const f = fixture([opening("reviewer")]);
    f.logs.set("reviewer", linesOf(testTurnFacts(0, "First.", ["one"]), at));
    const stop = f.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = f.store.snapshot.agents.reviewer!.observation;
    expect(before).toMatchObject({ status: "idle", position: 1, caughtUp: true });
    f.logs.get("reviewer")!.push(...linesOf(testTurnFacts(1, "Second.", ["two"]), at));
    await vi.advanceTimersByTimeAsync(1000);
    const after = f.store.snapshot.agents.reviewer!.observation;
    expect(after).toMatchObject({ status: "idle", position: 2, caughtUp: true });
    expect(conversation(before).messages).toHaveLength(2);
    expect(conversation(after).messages).toHaveLength(4);
    expect(f.requests.at(-1)?.cursor).toBe(1);
    f.denied.set("reviewer", 403);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.store.snapshot.agents.reviewer!.observation).toMatchObject({
      status: "unavailable",
      reason: "unauthorized",
      position: 2,
    });
    expect(conversation(f.store.snapshot.agents.reviewer!.observation).messages).toHaveLength(4);
    expect(f.store.snapshot.error).toBeUndefined();
    stop();
    const count = f.requests.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.requests).toHaveLength(count);
  });

  it("shares reused observations only after the server establishes their identity", async () => {
    const f = fixture([opening("left"), opening("right")]);
    f.logs.set("left", linesOf([opening("shared")], at));
    f.logs.set("right", linesOf([opening("shared")], at));
    f.logs.set("shared", linesOf(testTurnFacts(0, "Shared.", ["shared"]), at));
    f.start();
    await vi.waitFor(() => {
      const left = conversation(
        conversation(f.store.snapshot.agents.left!.observation).agents.shared!.observation,
      );
      const right = conversation(
        conversation(f.store.snapshot.agents.right!.observation).agents.shared!.observation,
      );
      expect(left.messages).toHaveLength(2);
      expect(left).toBe(right);
    });
    f.store.newSession();
    expect(f.store.snapshot.agents).toEqual({});
  });

  it("keeps equal session ids in different reader namespaces separate", async () => {
    const f = fixture([opening("left"), opening("right")]);
    for (const side of ["left", "right"]) {
      f.logs.set(side, linesOf([opening("shared")], at));
      const path = JSON.stringify([side, "shared"]);
      f.logs.set(path, linesOf(testTurnFacts(0, side, [side]), at));
      f.keys.set(path, JSON.stringify(["remote", side, "shared"]));
    }
    f.start();
    await vi.waitFor(() => {
      const observations = ["left", "right"].map(
        (side) =>
          conversation(f.store.snapshot.agents[side]!.observation).agents.shared!.observation,
      );
      expect(observations.every((observation) => observation.status === "idle")).toBe(true);
      expect(conversation(observations[0]!).messages.at(-1)?.parts).toContainEqual(
        expect.objectContaining({ text: "left" }),
      );
      expect(conversation(observations[1]!).messages.at(-1)?.parts).toContainEqual(
        expect.objectContaining({ text: "right" }),
      );
    });
  });

  it("retains source progress over eventless lines without refetching the suffix", async () => {
    vi.useFakeTimers();
    const f = fixture([opening("child")]);
    f.logs.set("child", [
      ...linesOf(testTurnFacts(0, "Known.", ["known"]), at),
      { at, facts: [{ type: "future.fact", data: {} }] },
      { progress: { type: "future.progress", data: {} } },
    ]);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    const observed = f.store.snapshot.agents.child!.observation;
    expect(observed).toMatchObject({ status: "idle", caughtUp: true, position: 3 });
    expect(position(conversation(observed).view)).toBe(3);
    expect(conversation(observed).messages).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests.at(-1)?.cursor).toBe(3);
  });

  it("stops the scheduling pass when a subscription replaces the root during publication", async () => {
    vi.useFakeTimers();
    const f = fixture([opening("first"), opening("second")]);
    let replaced = false;
    const unsubscribe = f.store.subscribe(() => {
      if (
        !replaced &&
        Object.values(f.store.snapshot.agents).some(
          ({ observation }) => observation.status === "following",
        )
      ) {
        replaced = true;
        f.store.newSession();
      }
    });
    f.start();
    await vi.advanceTimersByTimeAsync(60_000);
    unsubscribe();
    expect(replaced).toBe(true);
    expect(f.requests).toHaveLength(0);
    expect(f.store.snapshot.agents).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evaluates both reachable depths when a longer path establishes the shared observation first", async () => {
    const f = fixture([opening("shared"), opening("middle")], ({ depth }) => depth <= 2);
    f.logs.set("middle", linesOf([opening("shared")], at));
    f.logs.set("shared", linesOf([opening("leaf")], at));
    f.logs.set("leaf", linesOf(testTurnFacts(0, "Found.", ["found"]), at));
    const direct = Promise.withResolvers<void>();
    const serve = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => {
      const path = JSON.parse(new URL(String(input)).searchParams.get("children")!) as {
        sessionId: string;
      }[];
      if (path.length === 1 && path[0]?.sessionId === "shared") await direct.promise;
      return serve(input, init);
    });
    f.start();
    try {
      await vi.waitFor(() => {
        const shared = conversation(
          conversation(f.store.snapshot.agents.middle!.observation).agents.shared!.observation,
        );
        expect(shared.agents.leaf?.observation).toEqual({
          status: "not-followed",
          reason: "predicate",
        });
      });
    } finally {
      direct.resolve();
    }
    await vi.waitFor(() => {
      const shared = conversation(f.store.snapshot.agents.shared!.observation);
      expect(shared.agents.leaf?.observation).toMatchObject({ status: "idle", caughtUp: true });
      expect(conversation(shared.agents.leaf!.observation).messages).toHaveLength(2);
    });
    const leafRead = f.fetcher.mock.calls.find(([input]) => String(input).includes("leaf"));
    expect(JSON.parse(new URL(String(leafRead![0])).searchParams.get("children")!)).toHaveLength(2);
  });

  it("reference-counts headless observation scopes and tears down stalled reads without commands", async () => {
    const f = fixture([opening("silent")]);
    f.stalled.add("silent");
    const first = f.start();
    const second = f.start();
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    first();
    expect(f.requests[0]?.signal?.aborted).toBe(false);
    second();
    expect(f.requests[0]?.signal?.aborted).toBe(true);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
});
