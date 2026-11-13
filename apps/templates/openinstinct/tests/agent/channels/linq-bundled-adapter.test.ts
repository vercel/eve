import type * as LinqAdapter from "@linqapp/chat-sdk-adapter";
import { describe, expect, it, vi } from "vitest";

// Exercise the adapter Eve actually loads, not only the separately installed
// adapter used for its public declarations and application-level tests.
const { createLinqAdapter } = await vi.importActual<typeof LinqAdapter>(
  new URL(
    "./compiled/@linqapp/chat-sdk-adapter/index.js",
    import.meta.resolve("eve")
  ).pathname
);

describe("Eve bundled Linq adapter", () => {
  it("preserves native reply, media, and idempotency fields in the outgoing request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        chat_id: "chat-1",
        message: { id: "message-1" },
      })
    );
    const adapter = createLinqAdapter({
      apiKey: "test-key",
      baseURL: "https://linq.test",
      signingSecret: "test-secret",
    });
    try {
      await adapter.postMessage(
        adapter.encodeThreadId({ chatId: "chat-1" }),
        {
          raw: "Here it is.",
          attachments: [
            { type: "image", url: "https://media.example/room.png" },
          ],
        },
        { replyToMessageId: "original-message", idempotencyKey: "hotel-result" }
      );
      expect(fetch).toHaveBeenCalledOnce();
      const [input, init] = fetch.mock.calls[0] ?? [];
      const request =
        input instanceof Request ? input.clone() : new Response(init?.body);
      await expect(request.json()).resolves.toEqual({
        message: {
          parts: [
            { type: "text", value: "Here it is." },
            { type: "media", url: "https://media.example/room.png" },
          ],
          reply_to: { message_id: "original-message" },
          idempotency_key: "hotel-result",
        },
      });
    } finally {
      fetch.mockRestore();
    }
  });
});
