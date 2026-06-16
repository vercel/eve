import { describe, expect, it } from "vitest";

import {
  TELEGRAM_CALLBACK_RESPONSE_PREFIX,
  TELEGRAM_HITL_CALLBACK_PREFIX,
  TELEGRAM_REPLY_RESPONSE_PREFIX,
  isTelegramSyntheticResponse,
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  resolveTelegramInputResponses,
  telegramCallbackInputResponse,
  telegramReplyInputResponse,
  type TelegramHitlState,
} from "#public/channels/telegram/hitl.js";

describe("renderTelegramInputRequest", () => {
  it("renders option requests as compact inline-keyboard callbacks", () => {
    const state: TelegramHitlState = {};
    const rendered = renderTelegramInputRequest(
      {
        action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
        prompt: "Approve?",
        requestId: "very-long-request-id-that-would-not-fit-comfortably-in-callback-data",
      },
      state,
    );

    expect(rendered.replyMarkup).toEqual({
      inline_keyboard: [
        [
          { callback_data: "eve:0", text: "Approve" },
          { callback_data: "eve:1", text: "Deny" },
        ],
      ],
    });
    expect(Object.keys(state.hitlCallbacks ?? {})).toEqual(["eve:0", "eve:1"]);
    expect("eve:0".length).toBeLessThanOrEqual(64);
  });

  it("renders freeform requests as ForceReply prompts", () => {
    const rendered = renderTelegramInputRequest(
      {
        action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
        allowFreeform: true,
        prompt: "Explain",
        requestId: "call_1",
      },
      {},
    );

    expect(rendered).toMatchObject({
      freeformRequestId: "call_1",
      replyMarkup: { force_reply: true, selective: true },
      text: "Explain",
    });
  });
});

describe("resolveTelegramInputResponses", () => {
  it("maps compact callback ids back to real request ids", () => {
    const state: TelegramHitlState = {
      hitlCallbacks: {
        [`${TELEGRAM_HITL_CALLBACK_PREFIX}0`]: {
          optionId: "approve",
          requestId: "call_1",
        },
      },
    };

    expect(
      resolveTelegramInputResponses(state, [
        telegramCallbackInputResponse(`${TELEGRAM_HITL_CALLBACK_PREFIX}0`),
      ]),
    ).toEqual([{ optionId: "approve", requestId: "call_1" }]);
    expect(state.hitlCallbacks).toEqual({});
  });

  it("maps replies to ForceReply prompts back to freeform answers", () => {
    const state: TelegramHitlState = {};
    registerTelegramFreeformPrompt(state, { messageId: "99", requestId: "call_1" });

    expect(
      resolveTelegramInputResponses(state, [
        telegramReplyInputResponse({ messageId: "99", text: "approved" }),
      ]),
    ).toEqual([{ requestId: "call_1", text: "approved" }]);
    expect(state.pendingFreeformReplies).toEqual({});
  });

  it("skips stale synthetic responses and preserves normal responses", () => {
    const staleCallback = {
      optionId: "selected",
      requestId: `${TELEGRAM_CALLBACK_RESPONSE_PREFIX}eve:old`,
    };
    const staleReply = {
      requestId: `${TELEGRAM_REPLY_RESPONSE_PREFIX}99`,
      text: "ignored",
    };
    const normal = { requestId: "direct", optionId: "ok" };

    expect(resolveTelegramInputResponses({}, [staleCallback, staleReply, normal])).toEqual([
      normal,
    ]);
    expect(isTelegramSyntheticResponse(staleCallback)).toBe(true);
    expect(isTelegramSyntheticResponse(normal)).toBe(false);
  });
});
