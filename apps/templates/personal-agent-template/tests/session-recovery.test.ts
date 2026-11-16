import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { effectScope, nextTick } from "vue";
import type { ComputedRef, ShallowRef } from "vue";
import type { EveMessage, UseEveAgentOptions } from "eve/vue";
import type { EveSessionCursor, ThreadState } from "../lib/types/thread";
import { patchThreadBodySchema } from "../apps/web/server/schemas/threads";
import { conversationOf } from "eve/client";
import type { SessionEvent, SessionStreamEvent } from "eve/client";
import { createEveChatSession } from "../apps/web/app/composables/chat/providers/eve/session";
import { resetAllEveAgents } from "../apps/web/app/composables/chat/providers/eve/init";
import { resumeOptionsFromThread } from "../apps/web/app/composables/chat/providers/eve/thread-state";

type MockAgent = {
  events: ShallowRef<readonly SessionStreamEvent[]>;
  session: ShallowRef<EveSessionCursor | undefined>;
  error: ShallowRef<Error | undefined>;
  status: ShallowRef<string>;
  messages: ComputedRef<readonly EveMessage[]>;
  newSession: Mock<() => void>;
};
const transport = vi.hoisted(() => ({
  send: vi.fn(),
  resume: vi.fn(),
  created: [] as MockAgent[],
}));
vi.mock("eve/vue", async () => {
  const { shallowRef, computed } = await import("vue");
  return {
    useEveAgent(options: UseEveAgentOptions) {
      const events = shallowRef(options.initialEvents ?? []);
      const session = shallowRef<EveSessionCursor | undefined>(options.initialSession);
      const error = shallowRef<Error>();
      const status = shallowRef("idle");
      const agent = {
        events,
        session,
        error,
        status,
        messages: computed(() => conversationOf(events.value).messages),
        async send(text: string) {
          try {
            await transport.send(text, session.value);
          } catch (failure) {
            error.value = failure as Error;
            throw failure;
          }
          session.value = { sessionId: "replacement", streamIndex: 6, inbox: "new-inbox" };
          events.value = transcript(text, "New reply");
        },
        resume: transport.resume,
        respond: vi.fn(),
        cancel: vi.fn(),
        newSession: vi.fn(() => {
          events.value = [];
          session.value = undefined;
          error.value = undefined;
          status.value = "idle";
        }),
      };
      transport.created.push(agent);
      return agent;
    },
  };
});
vi.mock("../apps/web/app/composables/chat/navigation", () => ({ refreshThreadList: vi.fn() }));

function transcript(question: string, answer: string): SessionStreamEvent[] {
  const turnId = "turn",
    runId = "run";
  const scope = { turnId, runId };
  const events: SessionEvent[] = [
    { type: "delivery.admitted", data: { deliveryId: "delivery" } },
    {
      type: "turn.started",
      scope: { turnId },
      data: { turnId, cause: { deliveryId: "delivery" }, follows: null },
    },
    {
      type: "delivery.consumed",
      scope: { turnId },
      data: { turnId, deliveryId: "delivery", parts: [{ kind: "text", text: question }] },
    },
    { type: "model.requested", scope, data: { owner: { turnId }, runId } },
    {
      type: "content.completed",
      scope,
      data: { kind: "text", partId: "reply", phase: "reply", runId, value: answer },
    },
    { type: "turn.settled", scope: { turnId }, data: { turnId, outcome: "completed" } },
  ];
  return events.map((event, index) => ({
    ...event,
    meta: { at: "2026-01-01T00:00:00.000Z", position: { line: index, index: 0 }, endOfLine: true },
  }));
}
const original = {
  session: { sessionId: "original", streamIndex: 6, inbox: "old-inbox" },
  events: transcript("Old question", "Old answer"),
};
let scope: ReturnType<typeof effectScope>;
let saved: ThreadState | undefined;
const patch = vi.fn();
beforeEach(() => {
  scope = effectScope();
  saved = undefined;
  patch.mockReset();
  transport.send.mockReset();
  transport.resume.mockReset();
  transport.created = [];
  vi.stubGlobal(
    "$fetch",
    patch.mockImplementation(async (_url: string, options: { body: { state: ThreadState } }) => {
      saved = patchThreadBodySchema.parse(JSON.parse(JSON.stringify(options.body))).state;
    }),
  );
});
afterEach(() => {
  scope.stop();
  resetAllEveAgents();
  vi.unstubAllGlobals();
});
function chat(state: ThreadState = original) {
  return scope.run(() =>
    createEveChatSession(
      "thread",
      resumeOptionsFromThread({ id: "thread", title: "Chat", createdAt: 0, updatedAt: 0, state }),
    ),
  )!;
}
async function flushPersistence() {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
}

it.each(["session_expired", "session_stranded", "session_not_active"])(
  "recovers %s without losing saved history or the replacement inbox",
  async (code) => {
    transport.send
      .mockRejectedValueOnce(Object.assign(new Error("Session unavailable"), { code }))
      .mockResolvedValue(undefined);
    const current = chat();
    await current.retry();
    await flushPersistence();
    expect(transport.send.mock.calls.map((call) => call[0])).toEqual([
      "Old question",
      "Old question",
    ]);
    expect(transport.send.mock.calls[0]?.[1]).toEqual(original.session);
    expect(transport.send.mock.calls[1]?.[1]).toBeUndefined();
    expect(
      current.messages.value.flatMap((message) =>
        message.parts.filter((part) => part.type === "text").map((part) => part.text),
      ),
    ).toEqual(["Old question", "Old answer", "Old question", "New reply"]);
    expect(saved!.session).toEqual({
      sessionId: "replacement",
      streamIndex: 6,
      inbox: "new-inbox",
    });
    expect(saved!.history).toEqual([original]);
    expect(saved!.events).toEqual(transcript("Old question", "New reply"));
    expect(current.messages.value[0]?.metadata).toEqual({ retired: true });
    resetAllEveAgents();
    const reopened = chat(saved!);
    expect(
      reopened.messages.value.flatMap((message) =>
        message.parts.filter((part) => part.type === "text").map((part) => part.text),
      ),
    ).toEqual(["Old question", "Old answer", "Old question", "New reply"]);
    expect(transport.created.at(-1)!.session.value?.inbox).toBe("new-inbox");
  },
);

it("does not clear the old binding if saving its last events fails", async () => {
  const current = chat();
  transport.send.mockRejectedValue(
    Object.assign(new Error("Expired"), { code: "session_expired" }),
  );
  patch.mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(current.retry()).rejects.toThrow("Storage unavailable");
  expect(transport.created[0].newSession).not.toHaveBeenCalled();
  expect(transport.created[0].events.value).toEqual(original.events);
  expect(transport.send).toHaveBeenCalledTimes(1);
});

it("does not replace or resend after an ambiguous network error", async () => {
  const current = chat();
  transport.send.mockRejectedValue(new Error("Network disconnected"));
  await expect(current.sendMessage("Next question")).rejects.toThrow("Network disconnected");
  expect(transport.created[0].newSession).not.toHaveBeenCalled();
  expect(transport.send).toHaveBeenCalledTimes(1);
});

it("reconnects a busy session instead of repeating an accepted message", async () => {
  const current = chat();
  void current.messages.value;
  transport.created[0].status.value = "busy";
  transport.created[0].error.value = new Error("Stream disconnected");
  await current.retry();
  expect(transport.resume).toHaveBeenCalledTimes(1);
  expect(transport.send).not.toHaveBeenCalled();
});
