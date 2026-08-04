import { describe, expect, it } from "vitest";
import {
  canonicalAlternates,
  canonicalPathname,
  canonicalRoutes,
  integrationPath,
  templatePath,
} from "./canonical";

describe("canonical routes", () => {
  it("uses one path model for hubs and detail pages", () => {
    expect(canonicalRoutes).toEqual({
      home: "/",
      integrations: "/integrations",
      templates: "/templates",
    });
    expect(integrationPath("slack")).toBe("/integrations/slack");
    expect(templatePath("eve-chat-template")).toBe("/templates/eve-chat-template");
  });

  it("removes query and fragment variants from canonical paths", () => {
    expect(canonicalPathname("/integrations?filter=channel")).toBe("/integrations");
    expect(canonicalPathname("/docs/channels/overview#which-channel")).toBe(
      "/docs/channels/overview",
    );
  });

  it("preserves alternate representations while setting the HTML canonical", () => {
    expect(
      canonicalAlternates("/docs/channels/overview?view=all", {
        types: { "text/markdown": "/docs/channels/overview.md" },
      }),
    ).toEqual({
      canonical: "/docs/channels/overview",
      types: { "text/markdown": "/docs/channels/overview.md" },
    });
  });

  it.each(["https://other.example/docs", "//other.example/docs"])(
    "rejects cross-origin canonical value %s",
    (value) => {
      expect(() => canonicalPathname(value)).toThrow("Canonical path must be site-relative");
    },
  );
});
