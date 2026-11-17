import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";
import type { SessionEvent, SessionStreamEvent } from "eve/client";
import type { ThreadState } from "../lib/types/thread";
import { patchThreadBodySchema } from "../apps/web/server/schemas/threads";
import { createEveChatSession } from "../apps/web/app/composables/chat/providers/eve/session";
import { resetAllEveAgents } from "../apps/web/app/composables/chat/providers/eve/init";
import { resumeOptionsFromThread } from "../apps/web/app/composables/chat/providers/eve/thread-state";

vi.mock("../apps/web/app/composables/chat/navigation", () => ({ refreshThreadList: vi.fn() }));

function transcript(question: string, answer: string, prefix = "old"): SessionStreamEvent[] {
  const turnId = `${prefix}-turn`,
    runId = `${prefix}-run`,
    deliveryId = `${prefix}-delivery`;
  const scope = { turnId, runId };
  const events: SessionEvent[] = [
    { type: "delivery.admitted", data: { deliveryId } },
    {
      type: "turn.started",
      scope: { turnId },
      data: { turnId, cause: { deliveryId }, follows: null },
    },
    {
      type: "delivery.consumed",
      scope: { turnId },
      data: { turnId, deliveryId, parts: [{ kind: "text", text: question }] },
    },
    { type: "model.requested", scope, data: { owner: { turnId }, runId } },
    {
      type: "content.completed",
      scope,
      data: { kind: "text", partId: `${prefix}-reply`, phase: "reply", runId, value: answer },
    },
    { type: "turn.settled", scope: { turnId }, data: { turnId, outcome: "completed" } },
    { type: "delivery.settled", data: { deliveryId, turnId, outcome: "completed" } },
  ];
  return events.map((event, index) => ({
    ...event,
    meta: { at: "2026-01-01T00:00:00.000Z", position: { line: index, index: 0 }, endOfLine: true },
  }));
}
const original = {
  session: { sessionId: "original", streamIndex: 7, inbox: "old-inbox" },
  events: transcript("Old question", "Old answer"),
};
let scope: ReturnType<typeof effectScope>;
let saved: ThreadState | undefined;
const patch = vi.fn();
const post = vi.fn();
const reads: string[] = [];
let rejectRead = false;
const logs = new Map<string, SessionStreamEvent[]>();
const streams = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const encoder = new TextEncoder();
function wire(events: readonly SessionStreamEvent[]) {
  return events
    .map(({ meta, ...event }) => JSON.stringify({ at: meta.at, facts: [event] }) + "\n")
    .join("");
}
function append(sessionId: string, events: SessionStreamEvent[]) {
  const previous = logs.get(sessionId) ?? [];
  logs.set(sessionId, [...previous, ...events]);
  for (const stream of streams.get(sessionId) ?? []) stream.enqueue(encoder.encode(wire(events)));
}
function reject(code: string) {
  return Response.json({ code, error: "Session unavailable" }, { status: 409 });
}
beforeEach(() => {
  // Exercise the real Vue binding/store, including its failed optimistic submissions.
  vi.stubGlobal("window", {});
  scope = effectScope();
  saved = undefined;
  logs.clear();
  streams.clear();
  reads.length = 0;
  rejectRead = false;
  logs.set("original", original.events);
  patch.mockReset();
  post.mockReset();
  vi.stubGlobal(
    "$fetch",
    patch.mockImplementation(async (_url: string, options: { body: { state: ThreadState } }) => {
      saved = patchThreadBodySchema.parse(JSON.parse(JSON.stringify(options.body))).state;
    }),
  );
  post.mockImplementation(async (path: string, body: { message: string }) => {
    const sessionId = path.endsWith("/original") ? "original" : "replacement";
    append(sessionId, transcript(body.message, "New reply", "new"));
    return Response.json(
      { sessionId, deliveryId: "new-delivery", inbox: "new-inbox" },
      { status: 202 },
    );
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        String(request instanceof Request ? request.url : request),
        "https://eve.test",
      );
      if (init?.method === "POST") return await post(url.pathname, JSON.parse(String(init.body)));
      const sessionId = url.pathname.split("/").at(-2)!;
      reads.push(sessionId);
      if (rejectRead) {
        rejectRead = false;
        return Response.json({ code: "forbidden", error: "Stream disconnected" }, { status: 403 });
      }
      const events = logs.get(sessionId) ?? [];
      const start = Number(url.searchParams.get("startIndex") ?? "0");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(wire(events.slice(start))));
            const open = streams.get(sessionId) ?? new Set();
            streams.set(sessionId, open);
            open.add(controller);
            init?.signal?.addEventListener(
              "abort",
              () => {
                open.delete(controller);
                controller.error(init.signal?.reason);
              },
              { once: true },
            );
          },
        }),
        {
          headers: {
            "x-eve-stream-tail-index": String(events.length - 1),
            "x-eve-stream-version": "27",
          },
        },
      );
    }),
  );
});
afterEach(() => {
  resetAllEveAgents();
  scope.stop();
  vi.unstubAllGlobals();
});
function chat(state: ThreadState = original) {
  return scope.run(() => {
    const current = createEveChatSession(
      "thread",
      resumeOptionsFromThread({
        id: "thread",
        title: "Chat",
        createdAt: 0,
        updatedAt: 0,
        state,
      }),
    );
    void current.messages.value;
    return current;
  })!;
}
function texts(current: ReturnType<typeof chat>) {
  return current.messages.value.flatMap((message) =>
    message.parts.filter((part) => part.type === "text").map((part) => part.text),
  );
}
async function flushPersistence() {
  await nextTick();
  await vi.waitFor(() => expect(saved?.session?.sessionId).toBe("replacement"));
}

it.each(["session_expired", "session_stranded", "session_not_active"])(
  "recovers %s with event-only archives and durable replacement state",
  async (code) => {
    post.mockResolvedValueOnce(reject(code));
    const current = chat();
    await current.sendMessage("Next question");
    await flushPersistence();
    expect(post.mock.calls.map(([path]) => path)).toEqual([
      "/eve/v1/session/original",
      "/eve/v1/session",
    ]);
    expect(texts(current)).toEqual(["Old question", "Old answer", "Next question", "New reply"]);
    expect(saved!.history).toEqual([original]);
    expect(saved!.session?.sessionId).toBe("replacement");
    expect(current.messages.value[0]?.metadata).toEqual({ retired: true });
    resetAllEveAgents();
    const reopened = chat(saved!);
    expect(texts(reopened)).toEqual(["Old question", "Old answer", "Next question", "New reply"]);
  },
);

it("keeps concurrent retry clicks busy through retirement and replacement acceptance", async () => {
  const gate = Promise.withResolvers<void>();
  const acceptance = Promise.withResolvers<void>();
  patch.mockImplementation(async () => {
    await gate.promise;
  });
  const accept = post.getMockImplementation()!;
  post.mockResolvedValueOnce(reject("session_expired")).mockImplementationOnce(async (...args) => {
    await acceptance.promise;
    return await accept(...args);
  });
  const current = chat();
  const secondView = chat();
  const first = current.retry();
  await vi.waitFor(() => expect(patch).toHaveBeenCalled());
  expect(current.isBusy.value).toBe(true);
  await current.retry();
  gate.resolve();
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(secondView.isBusy.value).toBe(true);
  await secondView.retry();
  acceptance.resolve();
  await first;
  expect(post.mock.calls.map(([path]) => path)).toEqual([
    "/eve/v1/session/original",
    "/eve/v1/session",
  ]);
  await vi.waitFor(() =>
    expect(texts(current)).toEqual(["Old question", "Old answer", "Old question", "New reply"]),
  );
});

it("does not let pending retirement reset or deliver into an explicitly reset generation", async () => {
  const gate = Promise.withResolvers<void>();
  patch.mockImplementation(async () => {
    await gate.promise;
  });
  post.mockResolvedValueOnce(reject("session_expired"));
  const current = chat();
  const sending = current.sendMessage("Next question");
  await vi.waitFor(() => expect(patch).toHaveBeenCalled());
  current.reset();
  gate.resolve();
  await sending;
  expect(post).toHaveBeenCalledTimes(1);
  expect(texts(current)).toEqual([]);
});

it("retains the old binding when retirement persistence fails", async () => {
  const current = chat();
  post.mockResolvedValueOnce(reject("session_expired"));
  patch.mockRejectedValue(new Error("Storage unavailable"));
  await expect(current.sendMessage("Next question")).rejects.toThrow("Storage unavailable");
  expect(texts(current).slice(0, 2)).toEqual(["Old question", "Old answer"]);
  expect(post).toHaveBeenCalledTimes(1);
});

it("catches up an idle ambiguous POST without ever resending its indeterminate delivery", async () => {
  const current = chat();
  rejectRead = true;
  post.mockRejectedValueOnce(new Error("Network disconnected"));
  await expect(current.sendMessage("Next question")).rejects.toThrow("Network disconnected");
  expect(current.isBusy.value).toBe(false);
  // The server accepted work, but neither the receipt nor its stream facts reached the client.
  // Persist them only after the failed connection has closed, then recover over GET.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const readsBefore = reads.length;
  await current.retry();
  expect(reads.length).toBeGreaterThan(readsBefore);
  await current.retry();
  expect(post).toHaveBeenCalledTimes(1);
  append("original", transcript("Next question", "Accepted reply", "accepted"));
  await current.retry();
  await vi.waitFor(() => expect(texts(current)).toContain("Accepted reply"));
  await current.retry();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]?.[1].inbox).toBe("old-inbox");
});

it("does not infer non-delivery from an empty catch-up or a failed replacement POST", async () => {
  const current = chat();
  post
    .mockResolvedValueOnce(reject("session_expired"))
    .mockRejectedValueOnce(new Error("Receipt lost"));
  await expect(current.sendMessage("Next question")).rejects.toThrow("Receipt lost");
  // A lost create receipt has no session id to reconnect. Preserve uncertainty, not replay.
  await expect(current.retry()).rejects.toThrow("session");
  await expect(current.retry()).rejects.toThrow("session");
  expect(post).toHaveBeenCalledTimes(2);
});
