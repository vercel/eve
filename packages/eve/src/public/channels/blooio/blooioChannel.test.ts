import { describe, expect, it, vi } from "vitest";

import { blooioChannel } from "#public/channels/blooio/blooioChannel.js";
import { defaultEvents } from "#public/channels/blooio/defaults.js";
import { parseBlooioInboundMessage } from "#public/channels/blooio/inbound.js";
import { signBlooioPayload } from "#public/channels/blooio/verify.js";

const SECRET = "whsec_test_secret";

function getPostHandler(channel: ReturnType<typeof blooioChannel>) {
  const route = channel.routes.find(
    (r) => (r as { method?: string }).method === "POST",
  ) as { handler: (req: Request, args: unknown) => Promise<Response> };
  return route.handler;
}

function signedWebhook(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  return new Request("https://example.com/eve/v1/blooio", {
    method: "POST",
    headers: { "x-blooio-signature": `t=${t},v1=${signBlooioPayload(SECRET, t, body)}` },
    body,
  });
}

describe("parseBlooioInboundMessage", () => {
  it("routes 1:1 chats to the sender and group chats to the group id", () => {
    const direct = parseBlooioInboundMessage({
      event: "message.received",
      sender: "+15551234567",
      internal_id: "+15557654321",
      text: "hi",
    });
    expect(direct?.chatId).toBe("+15551234567");
    expect(direct?.isGroup).toBe(false);

    const group = parseBlooioInboundMessage({
      event: "message.received",
      is_group: true,
      group_id: "grp_abc",
      sender: "+15551234567",
      text: "hi all",
    });
    expect(group?.chatId).toBe("grp_abc");
    expect(group?.isGroup).toBe(true);
  });

  it("ignores non-received events", () => {
    expect(parseBlooioInboundMessage({ event: "message.delivered" })).toBeNull();
    expect(parseBlooioInboundMessage(null)).toBeNull();
  });
});

describe("blooioChannel inbound route", () => {
  it("dispatches a verified message.received webhook", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "sk", webhookSecret: SECRET } });
    const handler = getPostHandler(channel);

    const send = vi.fn(async () => ({ id: "session_1" }));
    const tasks: Promise<unknown>[] = [];
    const waitUntil = (task: Promise<unknown>) => {
      tasks.push(task);
    };

    const res = await handler(
      signedWebhook({
        event: "message.received",
        message_id: "msg_1",
        sender: "+15551234567",
        internal_id: "+15557654321",
        text: "hello",
      }),
      { send, waitUntil },
    );
    await Promise.all(tasks);

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0] as unknown as [
      { message: string },
      { continuationToken: string; state: { chatId: string } },
    ];
    expect(payload.message).toBe("hello");
    expect(options.continuationToken).toBe("+15557654321:+15551234567");
    expect(options.state.chatId).toBe("+15551234567");
  });

  it("rejects an unsigned webhook", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "sk", webhookSecret: SECRET } });
    const handler = getPostHandler(channel);
    const res = await handler(
      new Request("https://example.com/eve/v1/blooio", {
        method: "POST",
        body: JSON.stringify({ event: "message.received", sender: "+1" }),
      }),
      { send: vi.fn(), waitUntil: () => {} },
    );
    expect(res.status).toBe(401);
  });

  it("acks non-received events without dispatching", async () => {
    const channel = blooioChannel({ credentials: { apiKey: "sk", webhookSecret: SECRET } });
    const handler = getPostHandler(channel);
    const send = vi.fn();
    const res = await handler(signedWebhook({ event: "message.delivered", message_id: "msg_1" }), {
      send,
      waitUntil: () => {},
    });
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it("honors an allowFrom list", async () => {
    const channel = blooioChannel({
      allowFrom: ["+15559999999"],
      credentials: { apiKey: "sk", webhookSecret: SECRET },
    });
    const handler = getPostHandler(channel);
    const send = vi.fn();
    const res = await handler(
      signedWebhook({ event: "message.received", sender: "+15551234567", text: "hi" }),
      { send, waitUntil: () => {} },
    );
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("default message.completed handler", () => {
  it("sends the completed assistant message", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, status: 200, body: null }));
    const channel = { blooio: { sendMessage } } as never;
    await defaultEvents["message.completed"]!(
      { finishReason: "stop", message: "the answer", sequence: 0, stepIndex: 0, turnId: "t" },
      channel,
      {} as never,
    );
    expect(sendMessage).toHaveBeenCalledWith("the answer");
  });

  it("skips tool-call boundaries", async () => {
    const sendMessage = vi.fn();
    const channel = { blooio: { sendMessage } } as never;
    await defaultEvents["message.completed"]!(
      { finishReason: "tool-calls", message: null, sequence: 0, stepIndex: 0, turnId: "t" },
      channel,
      {} as never,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
