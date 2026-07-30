import { describe, expect, it } from "vitest";
import { publicationArguments } from "./publisher.js";

describe("Buzz publication arguments", () => {
  it("passes content over stdin and preserves the selected reply anchor", () => {
    expect(
      publicationArguments({
        channelId: "8bdf2680-5c6d-52e6-be27-8c688fb81262",
        replyTo: "a".repeat(64),
      }),
    ).toEqual([
      "messages",
      "send",
      "--channel",
      "8bdf2680-5c6d-52e6-be27-8c688fb81262",
      "--content",
      "-",
      "--reply-to",
      "a".repeat(64),
    ]);
  });
});
