import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  createHistoryViewPreparer,
  identityHistoryViewProjector,
  prepareHistoryView,
} from "#shared/history-view.js";

const messages: ModelMessage[] = [
  { content: "first", role: "user" },
  { content: "second", role: "assistant" },
];

describe("prepareHistoryView", () => {
  it("preserves the exact history array with the identity projector", () => {
    const prepared = prepareHistoryView({ messages });

    expect(prepared.messages).toBe(messages);
    expect(prepared.messages).toEqual(messages);
    expect(identityHistoryViewProjector({ messages, state: undefined })).toBe(messages);
  });

  it("reuses a prepared view until its raw messages or session state changes", () => {
    const state = { retained: true };
    const projector = vi.fn(({ messages: source }: { messages: readonly ModelMessage[] }) =>
      source.filter((message) => message.content !== "second"),
    );
    const prepare = createHistoryViewPreparer({ projector });
    const first = prepare(messages, state);
    const reused = prepare(messages, state);

    expect(reused).toBe(first);
    expect(projector).toHaveBeenCalledOnce();

    const nextMessages = [...messages, { content: "third", role: "user" as const }];
    const next = prepare(nextMessages, state);
    expect(next).not.toBe(first);
    expect(projector).toHaveBeenCalledTimes(2);

    prepare(nextMessages, { retained: true });
    expect(projector).toHaveBeenCalledTimes(3);
  });

  it("propagates projector failures without producing a partial view", () => {
    const error = new Error("projection failed");

    expect(() =>
      prepareHistoryView({
        messages,
        projector: () => {
          throw error;
        },
      }),
    ).toThrow(error);
  });
});
