import { describe, expect, it } from "vitest";

import {
  createResolveReadmeLinksPlugin,
  resolveReadmeHref,
  sanitizeReadmeHref,
} from "./readme-links";

const sourceRevisionHref =
  "https://github.com/vercel/eve/tree/0123456789abcdef/apps/fixtures/weather-agent";

describe("resolveReadmeHref", () => {
  it("resolves relative links from the template directory", () => {
    expect(resolveReadmeHref("docs/setup.md", sourceRevisionHref)).toBe(
      `${sourceRevisionHref}/docs/setup.md`,
    );
  });

  it("resolves repository-root links from the pinned revision", () => {
    expect(resolveReadmeHref("/CONTRIBUTING.md", sourceRevisionHref)).toBe(
      "https://github.com/vercel/eve/tree/0123456789abcdef/CONTRIBUTING.md",
    );
  });

  it("preserves page anchors and safe absolute links", () => {
    expect(resolveReadmeHref("#quick-start", sourceRevisionHref)).toBe("#quick-start");
    expect(resolveReadmeHref("https://eve.dev/docs", sourceRevisionHref)).toBe(
      "https://eve.dev/docs",
    );
  });

  it("rejects relative links when the source is not a pinned GitHub tree", () => {
    expect(resolveReadmeHref("docs/setup.md", "https://example.com/template")).toBeUndefined();
  });
});

describe("createResolveReadmeLinksPlugin", () => {
  it("resolves links before the markdown renderer sanitizes relative URLs", () => {
    const tree = {
      type: "root",
      children: [
        { type: "link", url: "docs/setup.md", children: [{ type: "text", value: "Setup" }] },
        { type: "paragraph", children: [{ type: "text", value: "No link" }] },
      ],
    };

    createResolveReadmeLinksPlugin(sourceRevisionHref)()(tree);

    expect(tree.children[0].url).toBe(`${sourceRevisionHref}/docs/setup.md`);
  });
});

describe("sanitizeReadmeHref", () => {
  it("allows web, email, telephone, relative, and anchor links", () => {
    expect(sanitizeReadmeHref("https://eve.dev")).toBe("https://eve.dev/");
    expect(sanitizeReadmeHref("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(sanitizeReadmeHref("tel:+15555555555")).toBe("tel:+15555555555");
    expect(sanitizeReadmeHref("docs/setup.md")).toBe("docs/setup.md");
    expect(sanitizeReadmeHref("#setup")).toBe("#setup");
  });

  it("rejects unsafe and protocol-relative URLs", () => {
    expect(sanitizeReadmeHref("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeReadmeHref("data:text/html,hello")).toBeUndefined();
    expect(sanitizeReadmeHref("//example.com/path")).toBeUndefined();
  });
});
