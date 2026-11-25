import { describe, expect, it } from "vitest";

import { toolModelOutputContext } from "#harness/tool-model-output.js";
import { webFetch, WEB_FETCH_INPUT_SCHEMA } from "#tools/provided/web-fetch.js";

function issues(value: unknown): readonly { readonly message: string }[] | undefined {
  const result = WEB_FETCH_INPUT_SCHEMA["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("Expected synchronous validation.");
  return result.issues;
}

describe("WEB_FETCH_INPUT_SCHEMA", () => {
  it.each([0, -1])("rejects a timeout of %s seconds", (timeout) => {
    expect(issues({ timeout, url: "https://example.com" })).toEqual([
      expect.objectContaining({ message: "timeout must be greater than 0 seconds." }),
    ]);
  });

  it("accepts a positive timeout, including one above the 120-second cap", () => {
    expect(issues({ timeout: 0.5, url: "https://example.com" })).toBeUndefined();
    expect(issues({ timeout: 500, url: "https://example.com" })).toBeUndefined();
  });
});

describe("webFetch.toModelOutput", () => {
  it("renders standard results as plain text and preserves wrapper extra fields as JSON", async () => {
    expect(
      await webFetch.toModelOutput?.(
        {
          content: "# Docs",
          contentType: "text/markdown",
          truncated: false,
          url: "https://example.com",
        },
        toolModelOutputContext("web_fetch", "call_1"),
      ),
    ).toEqual({ type: "text", value: "# Docs" });

    expect(
      await webFetch.toModelOutput?.(
        {
          content: "# Docs",
          contentType: "text/markdown",
          truncated: true,
          url: "https://example.com",
        },
        toolModelOutputContext("web_fetch", "call_2"),
      ),
    ).toEqual({ type: "text", value: "# Docs\n[truncated]" });

    const wrapped = {
      content: "# Docs",
      contentType: "text/markdown",
      extra: true,
      truncated: false,
      url: "https://example.com",
    };
    expect(
      await webFetch.toModelOutput?.(
        wrapped as never,
        toolModelOutputContext("web_fetch", "call_3"),
      ),
    ).toEqual({ type: "json", value: wrapped });
  });
});
