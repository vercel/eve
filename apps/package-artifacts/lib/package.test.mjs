import { describe, expect, test } from "vitest";

import {
  packageArtifactPath,
  packageDependencyUrl,
  packageManifest,
  packageManifestPath,
  packagePointerPath,
  packageVersion,
  publishablePackages,
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
    expect(packageArtifactPath(sha, "eve-video")).toBe(`packages/${sha}/eve-video.tgz`);
    expect(packageManifestPath(sha)).toBe(`packages/${sha}/manifest.json`);
    expect(packagePointerPath("main")).toBe("packages/refs/main.json");
    expect(packagePointerPath("123")).toBe("packages/refs/pr/123.json");
    expect(packageDependencyUrl("https://packages.example.com", sha, "eve")).toBe(
      `https://packages.example.com/${sha}/eve.tgz`,
    );
  });

  test("requires HTTPS and valid pointer refs", () => {
    expect(() => packageDependencyUrl("http://packages.example.com", sha, "eve")).toThrow(
      "must use HTTPS",
    );
    expect(() => packagePointerPath("0")).toThrow("positive pull request");
  });

  test("publishes every non-private workspace package under its npm tarball name", () => {
    const packages = publishablePackages([
      { name: "@eve/video", version: "0.0.0" },
      { name: "@eve/catalog", version: "0.0.1", private: true },
      { name: "eve", version: "1.5.0" },
      { name: "@vercel/agent-runs", version: "1.1.0" },
    ]);
    expect(packages.map(({ name, slug }) => [name, slug])).toEqual([
      ["@eve/video", "eve-video"],
      ["@vercel/agent-runs", "vercel-agent-runs"],
      ["eve", "eve"],
    ]);
    expect(() =>
      publishablePackages([
        { name: "eve", version: "1.0.0" },
        { name: "@eve/video", version: "0.0.0" },
        { name: "eve-video", version: "0.0.0" },
      ]),
    ).toThrow("must be unique");
    expect(() => publishablePackages([{ name: "@eve/video", version: "0.0.0" }])).toThrow(
      "eve package must be publishable",
    );
  });

  test("keeps eve at the manifest top level for existing consumers", () => {
    const eve = { version: "1.5.0+git.a", tarball: `https://pkg.eve.dev/${sha}/eve.tgz` };
    const video = { version: "0.0.0+git.a", tarball: `https://pkg.eve.dev/${sha}/eve-video.tgz` };
    const manifest = packageManifest(sha, [
      { name: "@eve/video", ...video, sha256: "c" },
      { name: "eve", ...eve, sha256: "b", bytes: Buffer.from("ignored") },
    ]);
    expect(manifest).toEqual({
      sourceSha: sha,
      ...eve,
      sha256: "b",
      packages: { "@eve/video": { ...video, sha256: "c" }, eve: { ...eve, sha256: "b" } },
    });
  });
});
