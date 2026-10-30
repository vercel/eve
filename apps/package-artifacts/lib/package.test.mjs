import { describe, expect, test } from "vitest";

import {
  packageArtifactPath,
  packageDependencyUrl,
  packageManifestPath,
  packagePointerPath,
  packageVersion,
  preparePackageJson,
} from "./package.mjs";

const sha = "a".repeat(40);

describe("package artifacts", () => {
  test("derives channel-specific build versions", () => {
    expect(packageVersion("0.33.0", sha)).toBe("0.33.0+main.aaaaaaaaaaaaaaaa");
    expect(packageVersion("0.33.0", sha, "git")).toBe("0.33.0+git.aaaaaaaaaaaaaaaa");
    expect(packageVersion("1.0.0-rc.0", sha, "git")).toBe("1.0.0-rc.0+git.aaaaaaaaaaaaaaaa");
    expect(() => packageVersion("1.0.0+git.abc", sha)).toThrow("without build metadata");
  });

  test("derives immutable artifacts and mutable pointers", () => {
    expect(packageArtifactPath(sha)).toBe(`packages/${sha}/eve.tgz`);
    expect(packageManifestPath(sha)).toBe(`packages/${sha}/manifest.json`);
    expect(packagePointerPath("main")).toBe("packages/refs/main.json");
    expect(packagePointerPath("123")).toBe("packages/refs/pr/123.json");
    expect(packageDependencyUrl("https://packages.example.com", sha)).toBe(
      `https://packages.example.com/${sha}/eve.tgz`,
    );
  });

  test("requires HTTPS and valid pointer refs", () => {
    expect(() => packageDependencyUrl("http://packages.example.com", sha)).toThrow(
      "must use HTTPS",
    );
    expect(() => packagePointerPath("0")).toThrow("positive pull request");
  });

  test("prepares package metadata without mutating the source", () => {
    const source = { name: "eve", version: "0.33.0" };
    expect(preparePackageJson(source, sha, "git")).toEqual({
      name: "eve",
      version: "0.33.0+git.aaaaaaaaaaaaaaaa",
    });
    expect(source.version).toBe("0.33.0");
  });
});
