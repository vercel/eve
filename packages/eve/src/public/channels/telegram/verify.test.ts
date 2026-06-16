import { describe, expect, it, vi } from "vitest";

import {
  verifyTelegramRequest,
  type TelegramWebhookVerifier,
} from "#public/channels/telegram/verify.js";

describe("verifyTelegramRequest", () => {
  it("returns the raw body when the secret-token header matches", async () => {
    const request = new Request("https://example.com/eve/v1/telegram", {
      body: JSON.stringify({ update_id: 1 }),
      headers: { "x-telegram-bot-api-secret-token": "secret" },
      method: "POST",
    });

    await expect(verifyTelegramRequest(request, { secretToken: "secret" })).resolves.toBe(
      JSON.stringify({ update_id: 1 }),
    );
  });

  it("rejects when the secret-token header is missing or different", async () => {
    const missing = new Request("https://example.com/eve/v1/telegram", {
      body: "{}",
      method: "POST",
    });
    await expect(verifyTelegramRequest(missing, { secretToken: "secret" })).rejects.toThrow(
      /missing Telegram secret-token header/,
    );

    const mismatch = new Request("https://example.com/eve/v1/telegram", {
      body: "{}",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      method: "POST",
    });
    await expect(verifyTelegramRequest(mismatch, { secretToken: "secret" })).rejects.toThrow(
      /secret-token mismatch/,
    );
  });

  it("delegates to a custom verifier and can substitute the body", async () => {
    const verifier: TelegramWebhookVerifier = vi.fn(() => '{"ok":true}');
    const request = new Request("https://example.com/eve/v1/telegram", {
      body: "{}",
      method: "POST",
    });

    await expect(
      verifyTelegramRequest(request, {
        secretToken: "wrong",
        webhookVerifier: verifier,
      }),
    ).resolves.toBe('{"ok":true}');
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it("rejects when the custom verifier returns a falsy value", async () => {
    const request = new Request("https://example.com/eve/v1/telegram", {
      body: "{}",
      method: "POST",
    });

    await expect(
      verifyTelegramRequest(request, {
        webhookVerifier: () => false,
        secretToken: undefined,
      }),
    ).rejects.toThrow(/verifier rejected/);
  });
});
