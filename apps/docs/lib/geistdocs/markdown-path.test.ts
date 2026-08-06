import { describe, expect, it } from "vitest";
import { getMarkdownRequestedPath } from "./markdown-path";

describe("getMarkdownRequestedPath", () => {
  it("restores flattened docs paths", () => {
    expect(getMarkdownRequestedPath({ slug: ["environment-variables"] })).toBe(
      "/docs/environment-variables",
    );
  });

  it("preserves integration paths", () => {
    expect(getMarkdownRequestedPath({ slug: ["integrations", "vercel"] })).toBe(
      "/integrations/vercel",
    );
  });

  it("maps the shared route root to the docs root", () => {
    expect(getMarkdownRequestedPath({ slug: [] })).toBe("/docs");
  });
});
