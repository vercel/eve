import type { MessageFilePart, MessagePart } from "#shared/message-content.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";
import { describe, expect, it } from "vitest";

import { prepareSessionHistory, serializeFilePartsInMessage } from "#channel/send-input.js";
import { readFileData } from "#internal/attachments/data.js";

describe("serializeFilePartsInMessage", () => {
  it("carries bytes, URLs, and data URL objects across a JSON boundary intact", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const message: MessagePart[] = [
      { type: "text", text: "two files" },
      { data: bytes, filename: "a.png", mediaType: "image/png", type: "file" },
      { data: new URL("https://example.com/b.pdf"), mediaType: "application/pdf", type: "file" },
      { data: new URL("data:text/plain;base64,SGVsbG8="), mediaType: "text/plain", type: "file" },
    ];

    const serialized = serializeFilePartsInMessage(message) as MessagePart[];
    expect(typeof (serialized[3] as MessageFilePart).data).toBe("string");

    const crossed = JSON.parse(JSON.stringify(serialized)) as MessagePart[];

    expect(crossed[0]).toEqual({ type: "text", text: "two files" });
    expect(readFileData((crossed[1] as MessageFilePart).data)).toEqual({ bytes, kind: "bytes" });
    expect((crossed[2] as MessageFilePart).data).toBe("eve-url:https://example.com/b.pdf");
    expect(readFileData((crossed[3] as MessageFilePart).data)).toEqual({
      bytes: Buffer.from("Hello"),
      kind: "bytes",
    });
  });
});

describe("prepareSessionHistory", () => {
  it("validates and serializes user file part bytes, URLs, and data URLs while leaving text and assistant entries unchanged", () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    const history: SessionHistoryMessage[] = [
      {
        parts: [
          { text: "Summarize", type: "text" },
          { data: bytes, filename: "a.pdf", mediaType: "application/pdf", type: "file" },
          {
            data: new URL("https://example.com/b.pdf"),
            mediaType: "application/pdf",
            type: "file",
          },
          {
            data: new URL("data:text/plain;base64,SGVsbG8="),
            mediaType: "text/plain",
            type: "file",
          },
        ],
        role: "user",
      },
      { role: "assistant", text: "Done." },
    ];

    const prepared = prepareSessionHistory(history);
    const preparedUser = prepared?.[0];
    const preparedParts = preparedUser?.role === "user" ? preparedUser.parts : undefined;
    expect(preparedParts).toBeDefined();
    expect(typeof (preparedParts![3] as MessageFilePart).data).toBe("string");

    const crossed = JSON.parse(JSON.stringify(prepared)) as SessionHistoryMessage[];

    const user = crossed[0]!;
    expect(user.role).toBe("user");
    const userParts = user.role === "user" ? user.parts : undefined;
    expect(userParts).toBeDefined();
    expect(userParts![0]).toEqual({ text: "Summarize", type: "text" });
    expect(readFileData((userParts![1] as MessageFilePart).data)).toEqual({
      bytes,
      kind: "bytes",
    });
    expect((userParts![2] as MessageFilePart).data).toBe("eve-url:https://example.com/b.pdf");
    expect(readFileData((userParts![3] as MessageFilePart).data)).toEqual({
      bytes: Buffer.from("Hello"),
      kind: "bytes",
    });
    expect(crossed[1]).toEqual({ role: "assistant", text: "Done." });
  });
});
