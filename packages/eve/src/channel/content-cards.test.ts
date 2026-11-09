import { describe, expect, it, vi } from "vitest";

import {
  dropContentCards,
  previewContentCard,
  replyMarkdownOf,
  showContentCard,
  type CardMessages,
  type ContentCardsState,
} from "#channel/content-cards.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { ContentCompletedData } from "#protocol/session-events/families/content.js";
import type { CardElement } from "#public/channels/slack/cards.js";
import {
  defineContentRenderer,
  type ContentRendererDefinition,
} from "#public/definitions/content-renderer.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const MEDIA_TYPE = "application/vnd.acme.summary+json";

const summary = defineContentRenderer({
  mediaType: MEDIA_TYPE,
  card(value) {
    const { title, total } = value as { title?: string; total?: string };
    if (title === undefined) return null;
    return {
      children: total === undefined ? [] : [{ content: total, type: "text" }],
      title,
      type: "card",
    } satisfies CardElement;
  },
  markdown(value) {
    return `**${(value as { title: string }).title}**`;
  },
});

/** Runs `fn` as a channel handler does: inside a step whose agent has `renderers`. */
function withRenderers<T>(renderers: readonly ContentRendererDefinition[], fn: () => Promise<T>) {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    resolvedAgent: {
      definitions: renderers.map((renderer) => ({ kind: "renderer", renderer })),
    },
  } as never);
  return contextStorage.run(ctx, fn);
}

function messages(streams = true) {
  const posted: CardElement[] = [];
  const edited: [string, CardElement][] = [];
  const removed: string[] = [];
  const surface: CardMessages = {
    edit: vi.fn(async (id: string, card: CardElement) => {
      edited.push([id, card]);
    }),
    post: vi.fn(async (card: CardElement) => {
      posted.push(card);
      return `m${posted.length}`;
    }),
    remove: vi.fn(async (id: string) => {
      removed.push(id);
    }),
    streams,
  };
  return { edited, posted, removed, surface };
}

const completed = (value: unknown): ContentCompletedData => ({
  callId: "call_0",
  fallbackText: "Weekly summary",
  kind: "card",
  mediaType: MEDIA_TYPE,
  partId: "call_0.reply",
  phase: "reply",
  value: value as never,
});

describe("content cards", () => {
  it("previews a card as its JSON streams, then replaces it with the finished card", async () => {
    vi.useFakeTimers();
    const { edited, posted, surface } = messages();
    const state: ContentCardsState = {};
    await withRenderers([summary], async () => {
      const delta = (text: string, announce = false) =>
        previewContentCard(surface, state, {
          delta: text,
          partId: "call_0.reply",
          ...(announce && { callId: "call_0", kind: "card", mediaType: MEDIA_TYPE }),
        });

      expect(await delta('{"title":"Wee', true)).toBe(true);
      vi.advanceTimersByTime(600);
      await delta('kly","total":"1,2');
      expect(
        await showContentCard(surface, state, completed({ title: "Weekly", total: "1,284" })),
      ).toBe(true);
    });
    vi.useRealTimers();

    expect(posted).toEqual([{ children: [], title: "Wee", type: "card" }]);
    expect(edited.at(-1)).toEqual([
      "m1",
      { children: [{ content: "1,284", type: "text" }], title: "Weekly", type: "card" },
    ]);
    expect(state.contentCards).toBeNull();
  });

  it("leaves a part no renderer draws to the channel's fallback text", async () => {
    const { posted, surface } = messages();
    const state: ContentCardsState = {};
    await withRenderers([], async () => {
      expect(
        await previewContentCard(surface, state, {
          callId: "call_0",
          delta: "{}",
          kind: "card",
          mediaType: MEDIA_TYPE,
          partId: "call_0.reply",
        }),
      ).toBe(false);
      expect(await showContentCard(surface, state, completed({ title: "Weekly" }))).toBe(false);
    });
    expect(posted).toEqual([]);
  });

  it("removes a preview its renderer can't finish, so the fallback text replaces it", async () => {
    const { removed, surface } = messages();
    const state: ContentCardsState = {
      contentCards: { "call_0.reply": { callId: "call_0", messageId: "m1", shown: "{}" } },
    };
    const broken = defineContentRenderer({
      card() {
        throw new Error("Unknown element type");
      },
      mediaType: MEDIA_TYPE,
    });
    const shown = await withRenderers([broken], () =>
      showContentCard(surface, state, completed({ title: "Weekly" })),
    );

    expect(shown).toBe(false);
    expect(removed).toEqual(["m1"]);
  });

  it("removes the previews of a call that failed", async () => {
    const { removed, surface } = messages();
    const state: ContentCardsState = {
      contentCards: {
        "call_0.reply": { callId: "call_0", messageId: "m1", shown: "{}" },
        "call_1.reply": { callId: "call_1", messageId: "m2", shown: "{}" },
      },
    };
    await dropContentCards(surface, state, "call_0");

    expect(removed).toEqual(["m1"]);
    expect(Object.keys(state.contentCards ?? {})).toEqual(["call_1.reply"]);
  });

  it("posts a renderer's markdown, or else the part's fallback text", async () => {
    const part = completed({ title: "Weekly" });
    expect(await withRenderers([summary], async () => replyMarkdownOf(part))).toBe("**Weekly**");
    expect(await withRenderers([], async () => replyMarkdownOf(part))).toBe("Weekly summary");
  });
});
