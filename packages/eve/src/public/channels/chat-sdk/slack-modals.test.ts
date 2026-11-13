import { createHmac } from "node:crypto";

import { expect, it, vi } from "vitest";

import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import { createSlackAdapter } from "#compiled/@chat-adapter/slack/index.js";
import { Modal, TextInput, type ModalSubmitEvent } from "#compiled/chat/index.js";
import { compiledChannel, postToChannelRoute } from "#internal/testing/mocks/mock-channel-calls.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { chatSdkChannel, type ChatSdkChannelState } from "#public/channels/chat-sdk/index.js";

const SIGNING_SECRET = "test-chat-sdk-signing-secret";

function signed(payload: unknown): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return new Request("https://example.com/eve/v1/slack", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
  });
}

it("exposes Chat SDK modal handlers with validation, native state, and view updates through eve's route", async () => {
  const bridge = chatSdkChannel({
    adapters: {
      slack: createSlackAdapter({
        botToken: "xoxb-test",
        botUserId: "U_BOT",
        signingSecret: SIGNING_SECRET,
      }),
    },
    state: createMemoryState(),
    userName: "review-bot",
    logger: "silent",
  });
  const send = vi.fn();
  const post = (payload: unknown) =>
    postToChannelRoute(
      compiledChannel<ChatSdkChannelState>(bridge.channel),
      signed(payload),
      mockChannelContext<ChatSdkChannelState>(send),
    );
  const handler = vi.fn(async (event: ModalSubmitEvent) => {
    if (!event.values.line?.trim()) {
      return { action: "errors" as const, errors: { line: "Enter a follow-up line." } };
    }
    return {
      action: "update" as const,
      modal: Modal({
        callbackId: "sales_review",
        title: "Review draft",
        children: [
          TextInput({ id: "line", label: "Follow-up line", initialValue: event.values.line }),
        ],
      }),
    };
  });
  bridge.bot.onModalSubmit("sales_review", handler);
  const submit = (value: string) =>
    post({
      type: "view_submission",
      team: { id: "T01" },
      user: { id: "U_ALICE", username: "alice" },
      view: {
        id: "V_REVIEW",
        callback_id: "sales_review",
        private_metadata: "draft-123",
        state: {
          values: {
            line: { line: { type: "plain_text_input", value } },
            facts: { correct: { type: "checkboxes", selected_options: [{ value: "company" }] } },
          },
        },
      },
    });

  const invalid = await submit("");
  expect(await invalid.json()).toEqual({
    response_action: "errors",
    errors: { line: "Enter a follow-up line." },
  });
  const preview = await submit("Thanks for meeting, Bob.");
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({
    response_action: "update",
    view: {
      type: "modal",
      callback_id: "sales_review",
      blocks: [
        {
          element: { type: "plain_text_input", initial_value: "Thanks for meeting, Bob." },
        },
      ],
    },
  });
  expect(handler).toHaveBeenCalledTimes(2);
  const event = handler.mock.calls[1]![0];
  expect(event.user.userId).toBe("U_ALICE");
  expect(event.raw).toMatchObject({
    view: {
      private_metadata: "draft-123",
      state: {
        values: {
          facts: { correct: { selected_options: [{ value: "company" }] } },
        },
      },
    },
  });
  expect(send).not.toHaveBeenCalled();
});
