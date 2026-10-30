import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { resendChannel, type ResendChannelConfig } from "#public/channels/resend/index.js";
import { signResendPayload } from "#public/channels/resend/verify.js";

const SECRET = `whsec_${Buffer.from("resend-test-secret").toString("base64")}`;

function receivedEmail(overrides: Record<string, unknown> = {}) {
  return {
    authentication: { dkim: "pass", dmarc: "pass", spf: "pass" },
    from: "Alice <alice@example.com>",
    headers: { references: "<root@example.com>" },
    id: "em_1",
    message_id: "<reply@example.com>",
    subject: "Re: Invoice",
    text: "Can you resend the invoice?",
    to: ["agent@acme.com"],
    ...overrides,
  };
}

function setup(config: Partial<ResendChannelConfig> = {}, email = receivedEmail()) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json(email);
    return Response.json({ id: "sent_1" });
  });
  const channel = resendChannel({
    allowFrom: "@example.com",
    api: { fetch },
    credentials: { apiKey: "re_test", webhookSecret: SECRET },
    fromAddress: "agent@acme.com",
    fromName: "Agent",
    ...config,
  });
  return { channel, fetch };
}

function webhook(from: string, secret = SECRET): Request {
  const body = JSON.stringify({ data: { email_id: "em_1", from }, type: "email.received" });
  const id = "msg_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://agent.example.com/eve/v1/resend", {
    body,
    headers: {
      "svix-id": id,
      "svix-signature": `v1,${signResendPayload({ body, id, secret, timestamp })}`,
      "svix-timestamp": timestamp,
    },
    method: "POST",
  });
}

async function post(compiled: unknown, request: Request) {
  if (!isCompiledChannel(compiled)) throw new Error("Expected a compiled channel.");
  const route = compiled.routes.find((candidate) => candidate.method === "POST");
  if (!route || !isHttpRouteDefinition(route)) throw new Error("No POST route.");
  const send = vi.fn();
  const pending: Promise<unknown>[] = [];
  const response = await route.handler(request, {
    ...mockAgentRouteArgs(),
    attachSession: vi.fn() as never,
    ...mockChannelContext(send),
    to: vi.fn() as never,
    params: {},
    requestIp: null,
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
  return { response, send };
}

describe("resendChannel", () => {
  it("dispatches a received email to the thread's session", async () => {
    const { channel } = setup();
    const { response, send } = await post(channel, webhook("Alice <alice@example.com>"));

    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledWith(
      "alice@example.com:<root@example.com>",
      expect.objectContaining({
        idempotencyKey: "resend:em_1",
        message: "Can you resend the invoice?",
        state: {
          address: "alice@example.com",
          references: ["<root@example.com>", "<reply@example.com>"],
          subject: "Re: Invoice",
        },
      }),
    );
  });

  it("rejects a webhook with a bad signature", async () => {
    const { channel, fetch } = setup();
    const { response } = await post(channel, webhook("alice@example.com", `whsec_${btoa("x")}`));

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores senders outside allowFrom without fetching the email", async () => {
    const { channel, fetch } = setup();
    const { response, send } = await post(channel, webhook("mallory@evil.test"));

    expect(response.status).toBe(204);
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("drops an email that failed DMARC by default", async () => {
    const { channel } = setup(
      {},
      receivedEmail({ authentication: { dkim: "fail", dmarc: "fail", spf: "fail" } }),
    );
    const { send } = await post(channel, webhook("alice@example.com"));

    expect(send).not.toHaveBeenCalled();
  });

  it("replies in the thread with In-Reply-To and References", async () => {
    const { channel, fetch } = setup({
      async onEmail(ctx) {
        await ctx.resend.reply("Sent again.");
        return null;
      },
    });
    await post(channel, webhook("alice@example.com"));

    const [url, init] = fetch.mock.calls.find(([, init]) => init.method === "POST")!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Agent <agent@acme.com>",
      headers: {
        "In-Reply-To": "<reply@example.com>",
        References: "<root@example.com> <reply@example.com>",
      },
      subject: "Re: Invoice",
      text: "Sent again.",
      to: ["alice@example.com"],
    });
  });
});
