import { describe, expect, it } from "vitest";

import { toolModelOutputContext } from "#harness/tool-model-output.js";
import { grep } from "#tools/provided/grep.js";

describe("grep.toModelOutput", () => {
  it("renders standard results as plain text and preserves wrapper extra fields as JSON", async () => {
    expect(
      await grep.toModelOutput?.(
        {
          content: "/workspace/a.ts:1:hello",
          matchCount: 1,
          outputMode: "content",
          path: "/workspace",
          truncated: false,
        },
        toolModelOutputContext("grep", "call_1"),
      ),
    ).toEqual({ type: "text", value: "/workspace/a.ts:1:hello" });

    const wrapped = {
      content: "/workspace/a.ts:1:hello",
      extra: "keep",
      matchCount: 1,
      outputMode: "content",
      path: "/workspace",
      truncated: false,
    };
    expect(
      await grep.toModelOutput?.(wrapped as never, toolModelOutputContext("grep", "call_2")),
    ).toEqual({ type: "json", value: wrapped });
  });
});
