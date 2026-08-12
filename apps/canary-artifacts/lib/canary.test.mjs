import { describe, expect, test } from "vitest";

import { canaryArtifactPath, canaryDependencyUrl, canaryVersion } from "./canary.mjs";

const sha = "a".repeat(40);

describe("canary artifacts", () => {
  test("derives the next patch canary version", () => {
    expect(canaryVersion("0.33.0", sha)).toBe(`0.33.1-canary.${sha}`);
  });

  test("derives immutable artifact and dependency URLs", () => {
    expect(canaryArtifactPath(sha, `0.33.1-canary.${sha}`)).toBe(
      `canary/${sha}/eve-0.33.1-canary.${sha}.tgz`,
    );
    expect(canaryDependencyUrl("store_AbCd123", sha, `0.33.1-canary.${sha}`)).toBe(
      `https://abcd123.public.blob.vercel-storage.com/canary/${sha}/eve-0.33.1-canary.${sha}.tgz`,
    );
  });

  test("rejects non-stable source versions", () => {
    expect(() => canaryVersion("0.33.1-canary.1", sha)).toThrow("Expected a stable eve version");
  });
});
