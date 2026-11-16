import { describe, expect, it } from "vitest";
import { chatTitle, messageContent } from "./message-input";

describe("chat message input", () => {
  it("uses trimmed text directly when there are no attachments", () => {
    expect(messageContent({ files: [], text: "  Hello  " })).toBe("Hello");
  });

  it("builds multimodal content without an empty text part", () => {
    expect(
      messageContent({
        files: [
          {
            filename: "receipt.png",
            mediaType: "image/png",
            type: "file",
            url: "data:image/png;base64,example",
          },
        ],
        text: "  ",
      })
    ).toEqual([
      {
        data: "data:image/png;base64,example",
        filename: "receipt.png",
        mediaType: "image/png",
        type: "file",
      },
    ]);
  });

  it("derives a title from text before falling back to a filename", () => {
    expect(chatTitle({ files: [], text: "  Plan a trip  " })).toBe(
      "Plan a trip"
    );
    expect(
      chatTitle({
        files: [
          {
            filename: "receipt.png",
            mediaType: "image/png",
            type: "file",
            url: "data:image/png;base64,example",
          },
        ],
        text: "",
      })
    ).toBe("receipt.png");
  });
});
