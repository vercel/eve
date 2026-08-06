import { describe, expect, it } from "vitest";
import { integrations } from "../integrations/data";
import { templateManifest } from "../templates/manifest";
import { integrationPath, templatePath } from "./canonical";

describe("authoritative hub discovery paths", () => {
  it("gives every integration a unique canonical child link", () => {
    const paths = integrations.map(({ slug }) => integrationPath(slug));

    expect(new Set(paths).size).toBe(integrations.length);
    expect(paths.every((path) => /^\/integrations\/[^/?#]+$/.test(path))).toBe(true);
  });

  it("gives every template a unique canonical child link", () => {
    const paths = templateManifest.map(({ slug }) => templatePath(slug));

    expect(new Set(paths).size).toBe(templateManifest.length);
    expect(paths.every((path) => /^\/templates\/[^/?#]+$/.test(path))).toBe(true);
  });
});
