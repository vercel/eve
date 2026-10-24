import { describe, expect, it } from "vitest";

import { parseRecallEvent } from "#public/channels/recall/inbound.js";

const bot = { id: "bot_1", metadata: { requestedBy: "alice", ignored: 3 } };
const participant = {
  email: null,
  extra_data: {},
  id: 12,
  is_host: true,
  name: " Alice ",
  platform: "desktop",
};

describe("parseRecallEvent", () => {
  it("joins transcript words and tidies the spaces before punctuation", () => {
    const event = parseRecallEvent({
      data: {
        bot,
        data: {
          participant,
          words: [
            { text: "Eve" },
            { text: "," },
            { text: "open" },
            { text: "a" },
            { text: "ticket" },
            { text: "." },
          ],
        },
      },
      event: "transcript.data",
    });

    expect(event).toEqual({
      botId: "bot_1",
      botMetadata: { requestedBy: "alice" },
      participant: { id: "12", isHost: true, name: "Alice" },
      text: "Eve, open a ticket.",
      type: "speech",
    });
  });

  it("reads a chat message and who it was sent to", () => {
    const event = parseRecallEvent({
      data: { bot, data: { data: { text: "hi eve", to: "only_bot" }, participant } },
      event: "participant_events.chat_message",
    });

    expect(event).toMatchObject({ text: "hi eve", to: "only_bot", type: "chat" });
  });

  it("reads a bot status webhook without a participant", () => {
    const event = parseRecallEvent({
      data: { bot, data: { code: "call_ended", sub_code: "call_ended_by_host" } },
      event: "bot.call_ended",
    });

    expect(event).toMatchObject({
      status: "call_ended",
      subCode: "call_ended_by_host",
      type: "status",
    });
  });

  it.each([
    [
      "an event the channel doesn't handle",
      { data: { bot, data: { participant } }, event: "participant_events.webcam_on" },
    ],
    [
      "an empty utterance",
      { data: { bot, data: { participant, words: [] } }, event: "transcript.data" },
    ],
    [
      "a payload without a bot",
      { data: { data: { participant } }, event: "participant_events.join" },
    ],
    [
      "a participant without an id",
      { data: { bot, data: { participant: { name: "x" } } }, event: "participant_events.join" },
    ],
  ])("ignores %s", (_name, payload) => {
    expect(parseRecallEvent(payload)).toBeNull();
  });
});
