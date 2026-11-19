import Browserbase from "@browserbasehq/sdk";
import { describe, expect, it } from "vitest";

import { BrowserSession } from "../../server/browser/browser-session.js";
import type { ConversationState } from "../../server/browser/types.js";

const live = process.env.BELL_LIVE_CONTEXT === "1" && Boolean(process.env.BROWSERBASE_API_KEY);

describe("opt-in live Context save", () => {
  it.runIf(live)(
    "captures state in an automatically attached draft Context",
    async () => {
      const apiKey = process.env.BROWSERBASE_API_KEY!;
      const sdk = new Browserbase({ apiKey });
      const marker = `bell-${Date.now()}`;
      const remote = await sdk.contexts.create({
        name: `Bell test ${Date.now()}`,
        ...(process.env.BROWSERBASE_PROJECT_ID
          ? { projectId: process.env.BROWSERBASE_PROJECT_ID }
          : {}),
      });
      const state = (id: string): ConversationState => ({
        id,
        traces: [],
        browser: { provider: "not-started", status: "idle" },
      });
      let writer: BrowserSession | undefined;
      let reader: BrowserSession | undefined;
      try {
        const writerState = state("context-capture-writer");
        writer = new BrowserSession(writerState, {
          ensureContext: async () => ({ id: remote.id, status: "draft" }),
        });
        await writer.importCookies(
          [
            {
              name: "bell_context_test",
              value: marker,
              url: "https://example.com/",
            },
          ],
          "https://example.com/",
        );
        expect(writerState.browser).toMatchObject({
          contextId: remote.id,
          contextStatus: "draft",
        });
        await writer.close();
        await new Promise((resolve) => setTimeout(resolve, 5_000));

        reader = new BrowserSession(state("context-capture-reader"), {
          contextId: remote.id,
        });
        await reader.run([{ action: "goto", url: "https://example.com/" }]);
        const restored = await reader.exportCookies();
        expect(restored.some((cookie) => cookie.value === marker)).toBe(true);
      } finally {
        try {
          const closed = await Promise.allSettled([writer?.close(), reader?.close()]);
          expect(closed.every((result) => result.status === "fulfilled")).toBe(true);
        } finally {
          await sdk.contexts.delete(remote.id, { headers: { "Content-Type": null } });
        }
      }
    },
    120_000,
  );
});
