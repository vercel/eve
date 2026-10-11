import type { FilePart, UserContent } from "ai";
import { describe, expect, it } from "vitest";

import { serializeFilePartsInMessage } from "#channel/send-input.js";
import { readFileData } from "#internal/attachments/data.js";

describe("serializeFilePartsInMessage", () => {
  it("carries bytes and URLs across a JSON boundary intact", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const message: UserContent = [
      { type: "text", text: "two files" },
      { data: bytes, filename: "a.png", mediaType: "image/png", type: "file" },
      { data: new URL("https://example.com/b.pdf"), mediaType: "application/pdf", type: "file" },
    ];

    const crossed = JSON.parse(JSON.stringify(serializeFilePartsInMessage(message))) as Exclude<
      UserContent,
      string
    >;

    expect(crossed[0]).toEqual({ type: "text", text: "two files" });
    expect(readFileData((crossed[1] as FilePart).data)).toEqual({ bytes, kind: "bytes" });
    expect((crossed[2] as FilePart).data).toBe("eve-url:https://example.com/b.pdf");
  });
});
