import { describe, expect, test } from "vitest";

import {
  packageArtifactPath,
  packageDependencyUrl,
  packageManifestPath,
  packageVersion,
  preparePackageJson,
} from "./package.mjs";

const sha = "a".repeat(40);

describe("package artifacts", () => {
  test("derives the next patch main version", () => {
    expect(packageVersion("0.33.0", sha)).toBe(`0.33.1-main.${sha}`);
  });

  test("derives immutable artifact and dependency URLs", () => {
    expect(packageArtifactPath(sha, `0.33.1-main.${sha}`)).toBe(
      `packages/${sha}/eve-0.33.1-main.${sha}.tgz`,
    );
    expect(packageManifestPath(sha)).toBe(`packages/${sha}/manifest.json`);
    expect(packageDependencyUrl(sha)).toBe(`https://pkg.eve.dev/${sha}/eve.tgz`);
  });

  test("prepares package metadata without mutating the source", () => {
    const source = { name: "eve", version: "0.33.0" };
    expect(preparePackageJson(source, sha)).toEqual({
      name: "eve",
      version: `0.33.1-main.${sha}`,
    });
    expect(source.version).toBe("0.33.0");
  });

  test("rejects non-stable source versions", () => {
    expect(() => packageVersion("0.33.1-main.1", sha)).toThrow("Expected a stable eve version");
  });
});
