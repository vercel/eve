import { describe, expect, it } from "vitest";

import { presentTool } from "./tool-presentation.js";

describe("presentTool", () => {
  it("renders web_fetch as a semantic URL activity", () => {
    const presentation = presentTool("web_fetch", {
      format: "markdown",
      url: "https://github.com/vercel/eve/issues/648",
    });

    expect(presentation.title).toBe("Fetch https://github.com/vercel/eve/issues/648");
    expect(presentation.subtitle).toBe("");
    expect(presentation.summarizeResult({ content: "large page" })).toBeUndefined();
    expect(presentation.group).toEqual({
      verb: "Fetch",
      singularNoun: "URL",
      pluralNoun: "URLs",
      item: "https://github.com/vercel/eve/issues/648",
    });
  });

  it("recognizes namespaced web_fetch tools", () => {
    expect(presentTool("eve.web_fetch", { url: "https://example.com" }).title).toBe(
      "Fetch https://example.com",
    );
  });

  it("falls back to the generic formatter for malformed input", () => {
    const presentation = presentTool("web_fetch", { format: "markdown" });

    expect(presentation.title).toBe("web_fetch");
    expect(presentation.subtitle).toContain('format="markdown"');
  });
});
