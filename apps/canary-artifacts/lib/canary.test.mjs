import { describe, expect, test } from "vitest";

import { canaryDependencyUrl, canaryVersion } from "./canary.mjs";

const sha = "a".repeat(40);

describe("canary artifacts", () => {
  test("derives the next patch canary version", () => {
    expect(canaryVersion("0.33.0", sha)).toBe(`0.33.1-canary.${sha}`);
  });

  test("derives the immutable deployment tarball URL", () => {
    expect(canaryDependencyUrl("eve-canary-abc123.vercel.app")).toBe(
      "https://eve-canary-abc123.vercel.app/canary/eve.tgz",
    );
  });

  test("rejects non-stable source versions", () => {
    expect(() => canaryVersion("0.33.1-canary.1", sha)).toThrow("Expected a stable eve version");
  });
});
