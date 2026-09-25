import { describe, expect, it } from "vitest";

import { readVercelResourceName, readVercelResourceSlug } from "./api-resource.js";

describe("Vercel API resource identity", () => {
  it("prefers a display name and falls back to a valid slug", () => {
    expect(readVercelResourceName({ name: "Acme Inc.", slug: "acme" })).toBe("Acme Inc.");
    expect(readVercelResourceName({ slug: "acme-platform" })).toBe("acme-platform");
  });

  it("rejects empty names and invalid slugs", () => {
    expect(readVercelResourceName({ name: "", slug: "Acme Team" })).toBeUndefined();
    expect(readVercelResourceSlug({ slug: "Acme Team" })).toBeUndefined();
    expect(readVercelResourceSlug(null)).toBeUndefined();
  });
});
