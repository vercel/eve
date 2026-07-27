import { describe, expect, it, vi } from "vitest";

import { Client, type StampedHandleMessageStreamEvent } from "#client/index.js";
import { stampTestEvent } from "#internal/testing/events.js";
import type { HandleMessageStreamEvent, SubagentCalledStreamEvent } from "#protocol/message.js";

import { SubagentPump, type SubagentView } from "./subagent-pump.js";

function fakeView(): SubagentView {
  return {
    begin: vi.fn(),
    upsertStep: vi.fn(),
    upsertTool: vi.fn(),
    removeTool: vi.fn(),
    complete: vi.fn(),
    markChildToolCallId: vi.fn(),
  };
}

/**
 * A hand-pumped child event stream: events pushed after `settleAll` aborts
 * the pump must never reach the view.
 */
function pushableChildStream() {
  const queue: StampedHandleMessageStreamEvent[] = [];
  let wake: (() => void) | undefined;
  let aborted = false;

  return {
    push(event: StampedHandleMessageStreamEvent) {
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    stream(options?: { signal?: AbortSignal }): AsyncIterable<StampedHandleMessageStreamEvent> {
      const signal = options?.signal;
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (signal?.aborted) {
              aborted = true;
              return;
            }
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      };
    },
    get aborted() {
      return aborted;
    },
  };
}

function subagentCalled(callId: string): SubagentCalledStreamEvent {
  return {
    type: "subagent.called",
    data: {
      callId,
      childSessionId: `child_${callId}`,
      name: "researcher",
      sequence: 1,
      turnId: "turn-1",
    },
  } as SubagentCalledStreamEvent;
}

function reasoningEvent(delta: string, index = 0): StampedHandleMessageStreamEvent {
  return stampTestEvent(
    {
      type: "reasoning.appended",
      data: {
        reasoningDelta: delta,
        reasoningSoFar: delta,
        sequence: 2,
        stepIndex: 0,
        turnId: "child-turn",
      },
    } as HandleMessageStreamEvent,
    index,
  );
}

function boundaryEvent(index: number): StampedHandleMessageStreamEvent {
  return stampTestEvent(
    { type: "session.waiting", data: { wait: "next-user-message" } } as HandleMessageStreamEvent,
    index,
  );
}

async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("SubagentPump.settleAll", () => {
  it("closes live sections and stops stale child output after a cancelled turn", async () => {
    const child = pushableChildStream();
    const client = new Client({ host: "http://localhost:3000" });
    vi.spyOn(client, "session").mockReturnValue({
      stream: (options?: { signal?: AbortSignal }) => child.stream(options),
    } as never);
    const view = fakeView();
    const pump = new SubagentPump({ client, view, formatActionResultError: () => "failed" });

    pump.begin(subagentCalled("call-1"));
    child.push(reasoningEvent("**Searching for current events**", 0));
    await settleAsyncWork();
    expect(view.upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", finalized: false }),
    );

    // The parent turn is cancelled: sections settle and the stream stops.
    pump.settleAll();
    expect(view.complete).toHaveBeenCalledWith({ callId: "call-1" });
    expect(view.upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", finalized: true }),
    );

    // A child still flushing output after the cancel paints nothing.
    const updatesAfterSettle = vi.mocked(view.upsertStep).mock.calls.length;
    child.push(reasoningEvent("stale output", 1));
    await settleAsyncWork();
    expect(vi.mocked(view.upsertStep).mock.calls.length).toBe(updatesAfterSettle);

    // The parent's late `subagent.completed` fallback settles as a no-op.
    const completions = vi.mocked(view.complete).mock.calls.length;
    pump.settle("call-1");
    expect(vi.mocked(view.complete).mock.calls.length).toBe(completions);
  });
});

describe("SubagentPump child stream replay", () => {
  it("folds a replayed child transcript in once when the pump restarts", async () => {
    const transcript = [reasoningEvent("looked up the forecast", 0), boundaryEvent(1)];
    let opened = 0;
    const client = new Client({ host: "http://localhost:3000" });
    vi.spyOn(client, "session").mockReturnValue({
      stream: () => {
        opened += 1;
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of transcript) yield event;
          },
        };
      },
    } as never);
    const view = fakeView();
    const pump = new SubagentPump({ client, view, formatActionResultError: () => "failed" });

    const called = subagentCalled("call-1");
    pump.begin(called);
    await settleAsyncWork();
    pump.begin(called);
    await settleAsyncWork();

    expect(opened).toBe(2);
    const reasoning = vi
      .mocked(view.upsertStep)
      .mock.calls.map(([update]) => update.reasoning)
      .filter((text): text is string => text !== undefined && text.length > 0);
    expect(reasoning.length).toBeGreaterThan(0);
    for (const text of reasoning) {
      expect(text).toBe("looked up the forecast");
    }
    const sectionKeys = new Set(
      vi.mocked(view.upsertStep).mock.calls.map(([update]) => update.sectionKey),
    );
    expect(sectionKeys.size).toBe(1);
  });
});
