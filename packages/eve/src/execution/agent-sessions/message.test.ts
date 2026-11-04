import { expect, it } from "vitest";

import { normalizeAgentMessage } from "#execution/agent-sessions/message.js";

it("serializes URL file references beside text for workflow messages", () => {
  expect(
    normalizeAgentMessage([
      { type: "text", text: "Review Alice's report." },
      {
        type: "file",
        data: new URL("https://files.example/report.pdf"),
        mediaType: "application/pdf",
        filename: "report.pdf",
      },
    ]),
  ).toEqual([
    { type: "text", text: "Review Alice's report." },
    {
      type: "file",
      data: "https://files.example/report.pdf",
      mediaType: "application/pdf",
      filename: "report.pdf",
    },
  ]);
});

it.each(["data:application/pdf;base64,AA==", "AA==", new Uint8Array([0])])(
  "rejects inline workflow attachments",
  (data) => {
    expect(() =>
      normalizeAgentMessage([
        // @ts-expect-error Bytes are also rejected for JavaScript callers, not just by TypeScript.
        { type: "file", data, mediaType: "application/pdf" },
      ]),
    ).toThrow("HTTP(S) URL");
  },
);

it.each(["", [], [{ type: "text", text: "  " }]])(
  "rejects an empty workflow message",
  (message) => {
    expect(() =>
      normalizeAgentMessage(message as Parameters<typeof normalizeAgentMessage>[0]),
    ).toThrow("requires");
  },
);
