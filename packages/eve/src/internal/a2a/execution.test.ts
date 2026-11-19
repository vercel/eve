import { describe, expect, it } from "vitest";

import { toMessageContent } from "./execution.js";
import { A2aError } from "./protocol.js";

const message = (parts: object[]) => ({
  messageId: "m-1",
  parts,
  role: "ROLE_USER" as const,
});

describe("toMessageContent", () => {
  it("passes one text part as plain text and the rest as message parts", () => {
    expect(toMessageContent(message([{ text: "hi" }]))).toBe("hi");
    expect(
      toMessageContent(
        message([
          { text: "Look:" },
          { filename: "a.png", mediaType: "image/png", raw: "iVBORw0KGgo=" },
          { mediaType: "image/jpeg", url: "https://example.com/b.jpg" },
          { data: { order: 42 } },
        ]),
      ),
    ).toEqual([
      { text: "Look:", type: "text" },
      { data: "iVBORw0KGgo=", filename: "a.png", mediaType: "image/png", type: "file" },
      { data: "https://example.com/b.jpg", mediaType: "image/jpeg", type: "file" },
      { text: '{"order":42}', type: "text" },
    ]);
  });

  it("refuses file data in eve's internal ref schemes", () => {
    for (const raw of ["eve-sandbox:/workspace/secret.txt", "eve-url:https://example.com/a"]) {
      expect(() => toMessageContent(message([{ mediaType: "text/plain", raw }]))).toThrow(A2aError);
    }
  });
});
