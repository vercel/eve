import { describe, expect, it, vi } from "vitest";

import { fetchTelegramBotUsername } from "./management.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchTelegramBotUsername", () => {
  it("returns the bot username from getMe", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ ok: true, result: { id: 1, is_bot: true, username: "my_bot" } }),
    );
    await expect(fetchTelegramBotUsername("123:abc", undefined, { fetch })).resolves.toBe("my_bot");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:abc/getMe",
      expect.anything(),
    );
  });

  it("rejects a token Telegram does not accept", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: false }, 401));
    await expect(fetchTelegramBotUsername("bad", undefined, { fetch })).rejects.toThrow(
      "Telegram rejected the bot token (401)",
    );
  });
});
