import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { countUnsizedParts } from "#harness/token-estimate.js";

const pdf: unknown = {
  data: new URL("https://example.com/a.pdf"),
  mediaType: "application/pdf",
  type: "file",
};

describe("countUnsizedParts", () => {
  it("counts remote non-image files in messages and in content tool outputs", () => {
    const messages: ModelMessage[] = [
      { content: [{ text: "see", type: "text" }, pdf as never], role: "user" },
      {
        content: [
          {
            output: { type: "content", value: [pdf] as never },
            toolCallId: "c",
            toolName: "t",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    expect(countUnsizedParts(messages)).toBe(2);
  });

  it("skips remote images, inline data and file-shaped text, without reading file data", () => {
    const huge = new Uint8Array(32 * 1024 * 1024);
    const messages = [
      {
        content: [
          {
            image: new URL("https://example.com/a.png"),
            mediaType: "image/png",
            type: "file",
            data: new URL("https://example.com/a.png"),
          },
          { data: huge, mediaType: "application/pdf", type: "file" },
          { text: JSON.stringify(pdf), type: "text" },
        ],
        role: "user",
      },
    ] as ModelMessage[];
    const started = performance.now();
    expect(countUnsizedParts(messages)).toBe(0);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
