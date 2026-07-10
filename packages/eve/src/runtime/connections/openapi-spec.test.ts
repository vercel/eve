import { describe, expect, it } from "vitest";

import { parseSpecDocument } from "#runtime/connections/openapi-spec.js";

describe("parseSpecDocument", () => {
  it("parses JSON specs", () => {
    expect(parseSpecDocument('{"openapi":"3.0.0"}')).toEqual({ openapi: "3.0.0" });
  });

  it("parses YAML specs", () => {
    expect(parseSpecDocument("openapi: 3.0.0\ninfo:\n  title: T")).toEqual({
      openapi: "3.0.0",
      info: { title: "T" },
    });
  });

  it("does not evaluate a JavaScript frontmatter fence", () => {
    const marker = "eve_openapi_spec_js_marker";
    const body = `---js\n(globalThis[${JSON.stringify(marker)}] = true)\n---\n`;

    expect(() => parseSpecDocument(body)).toThrow(/JavaScript frontmatter is not supported/);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });
});
