import { describe, expect, it, type Mock, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { INACTIVE_REQUEST_NOTICE } from "#channel/inactive-prompt.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { telegramChannel } from "#public/channels/telegram/index.js";

const SECRET = "telegram-secret";

/** Posts `body` to the channel's webhook and drains every task it hands to `waitUntil`. */
async function firePost(
  channel: unknown,
  body: unknown,
  send: Mock<(...args: any[]) => Promise<unknown>>,
): Promise<void> {
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const post = channel.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) throw new Error("Expected a POST route.");
  const waitUntil = vi.fn();
  await post.handler(
    new Request("https://example.com/eve/v1/telegram", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      method: "POST",
    }),
    {
      ...mockAgentRouteArgs(),
      attachSession: vi.fn() as never,
      ...mockChannelContext(send),
      resolveSession: async () => undefined,
      to: vi.fn() as never,
      params: {},
      requestIp: null,
      waitUntil,
    },
  );
  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }
}

describe("telegramChannel press no session takes", () => {
  it("tells the presser a prompt is inactive without waiting for its buttons to clear", async () => {
    let releaseEdit!: () => void;
    const editHeld = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    const methods: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      methods.push(method);
      if (method === "editMessageText") await editHeld;
      return new Response(JSON.stringify({ ok: true, result: true }));
    });
    const channel = telegramChannel({
      api: { fetch: fetchMock },
      credentials: { botToken: "bot-token", webhookSecretToken: SECRET },
    });

    const posted = firePost(
      channel,
      {
        callback_query: {
          data: "eve:0",
          from: { id: "U1", is_bot: false },
          id: "cb-inactive",
          message: { chat: { id: 42, type: "private" }, message_id: 55, text: "Deploy?" },
        },
      },
      vi.fn().mockRejectedValue(new SessionNotActiveError()),
    );
    await vi.waitFor(() => expect(methods).toEqual(["editMessageText", "answerCallbackQuery"]));
    releaseEdit();
    await posted;

    const ack = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/answerCallbackQuery"));
    expect(JSON.parse(String((ack![1] as RequestInit).body))).toEqual({
      callback_query_id: "cb-inactive",
      text: INACTIVE_REQUEST_NOTICE,
    });
    expect(methods).toEqual(["editMessageText", "answerCallbackQuery"]);
  });
});
