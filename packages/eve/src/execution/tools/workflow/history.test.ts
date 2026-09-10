import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { copyWorkflowHistory } from "#execution/tools/workflow/history.js";

describe("copyWorkflowHistory", () => {
  it("copies and deeply freezes plain workflow history", () => {
    const source = [
      {
        content: [
          {
            text: "Earlier request",
            type: "text" as const,
          },
        ],
        role: "user" as const,
      },
    ];

    const history = copyWorkflowHistory(source);

    expect(history).toEqual(source);
    expect(history).not.toBe(source);
    expect(history[0]).not.toBe(source[0]);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
    expect(Object.isFrozen(history[0]?.content)).toBe(true);
    expect(Object.isFrozen((history[0]?.content as readonly unknown[])[0])).toBe(true);
  });

  it("copies URL and binary attachment values without freezing their views", () => {
    const url = new URL("https://example.com/chart.png");
    const bytes = Buffer.from([1, 2, 3]);
    const source = [
      {
        role: "user",
        content: [
          { type: "image", image: url },
          { type: "image", image: bytes },
        ],
      },
    ] as ModelMessage[];

    const history = copyWorkflowHistory(source);
    const content = history[0]?.content;
    if (!Array.isArray(content)) throw new Error("Expected structured history content.");
    const urlPart = content[0];
    const bytesPart = content[1];
    if (urlPart?.type !== "image" || bytesPart?.type !== "image") {
      throw new Error("Expected image history parts.");
    }

    expect(urlPart.image).toBeInstanceOf(URL);
    expect(urlPart.image).not.toBe(url);
    expect(bytesPart.image).toBeInstanceOf(Uint8Array);
    if (!(bytesPart.image instanceof Uint8Array)) throw new Error("Expected copied bytes.");
    expect(bytesPart.image).not.toBe(bytes);
    expect(Array.from(bytesPart.image)).toEqual([1, 2, 3]);
    bytes[0] = 9;
    expect(Array.from(bytesPart.image)).toEqual([1, 2, 3]);
  });
});
