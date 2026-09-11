import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseDiscordGatewayMessage,
  verifyDiscordGatewayRequest,
} from "#public/channels/discord/gateway.js";

const applicationId = "APP1";
const secret = "test-secret";

function signedRequest(body: string, overrides: Record<string, string> = {}): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const application = overrides["x-eve-discord-application"] ?? applicationId;
  const signature = createHmac("sha256", secret)
    .update(`v1\n${timestamp}\n${application}\n${body}`, "utf8")
    .digest("hex");
  return new Request("https://example.com/eve/v1/discord/gateway", {
    body,
    headers: {
      "content-type": "application/json",
      "x-eve-discord-application": application,
      "x-eve-discord-signature": overrides["x-eve-discord-signature"] ?? `v1=${signature}`,
      "x-eve-discord-timestamp": overrides["x-eve-discord-timestamp"] ?? timestamp,
    },
    method: "POST",
  });
}

function envelope(data: unknown = message()): string {
  return JSON.stringify({
    applicationId,
    data,
    deliveryId: "discord:APP1:message:M1",
    event: "MESSAGE_CREATE",
    sequence: 42,
    version: 1,
  });
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    author: { id: "U1", username: "ada" },
    channel_id: "C1",
    content: "hello",
    guild_id: "G1",
    id: "M1",
    mentions: [{ id: "APP1" }],
    ...overrides,
  };
}

describe("Discord Gateway envelope", () => {
  it("verifies the canonical timestamped HMAC before parsing its envelope", async () => {
    const body = envelope();
    await expect(
      verifyDiscordGatewayRequest(signedRequest(body), { applicationId, secret }),
    ).resolves.toMatchObject({ envelope: { applicationId, event: "MESSAGE_CREATE", version: 1 } });
  });

  it("rejects application mismatches and malformed signatures", async () => {
    await expect(
      verifyDiscordGatewayRequest(
        signedRequest(envelope(), { "x-eve-discord-application": "other" }),
        {
          applicationId,
          secret,
        },
      ),
    ).rejects.toMatchObject({ reason: "application_mismatch", status: 401 });
    await expect(
      verifyDiscordGatewayRequest(
        signedRequest(envelope(), { "x-eve-discord-signature": "v1=not-a-digest" }),
        { applicationId, secret },
      ),
    ).rejects.toMatchObject({ reason: "invalid_signature_headers", status: 401 });
  });
});

describe("Discord Gateway messages", () => {
  it("normalizes messages without exposing Discord SDK types", () => {
    const parsed = parseDiscordGatewayMessage(
      message({
        attachments: [{ filename: "notes.txt", id: "A1", url: "https://example.com/A1" }],
      }),
    );
    expect(parsed).toMatchObject({
      attachments: [{ filename: "notes.txt", id: "A1" }],
      author: { id: "U1", isBot: false },
      channelId: "C1",
      guildId: "G1",
      id: "M1",
    });
  });
});
