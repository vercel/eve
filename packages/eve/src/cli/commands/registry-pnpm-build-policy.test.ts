import { describe, expect, it } from "vitest";

import { withPnpmBuildPolicy } from "./registry-pnpm-build-policy.js";

describe("pnpm registry build policy", () => {
  it("adds exact optional dependencies to the ignored list", () => {
    expect(
      withPnpmBuildPolicy(
        "packages:\n  - apps/*\n\nallowBuilds:\n  sharp: false\n",
        ["node-liblzma", "@mongodb-js/zstd"],
        "ignore-optional",
      ),
    ).toBe(
      'packages:\n  - apps/*\n\nallowBuilds:\n  sharp: false\n\nignoredOptionalDependencies:\n  - "@mongodb-js/zstd"\n  - "node-liblzma"\n',
    );
  });

  it("replaces an ignored decision when build scripts are allowed", () => {
    expect(
      withPnpmBuildPolicy(
        'ignoredOptionalDependencies:\n  - "@mongodb-js/zstd"\n  - cbor-extract\n  - node-liblzma\n',
        ["node-liblzma", "@mongodb-js/zstd"],
        "allow-builds",
      ),
    ).toBe(
      'ignoredOptionalDependencies:\n  - cbor-extract\n\nallowBuilds:\n  "@mongodb-js/zstd": true\n  "node-liblzma": true\n',
    );
  });

  it("replaces an allowed decision when optional packages are ignored", () => {
    expect(
      withPnpmBuildPolicy(
        'allowBuilds:\n  "@mongodb-js/zstd": true\n  esbuild: true\n  node-liblzma: false\n',
        ["node-liblzma", "@mongodb-js/zstd"],
        "ignore-optional",
      ),
    ).toBe(
      'allowBuilds:\n  esbuild: true\n\nignoredOptionalDependencies:\n  - "@mongodb-js/zstd"\n  - "node-liblzma"\n',
    );
  });

  it("refuses inline policy structures instead of corrupting them", () => {
    expect(() =>
      withPnpmBuildPolicy("allowBuilds: { esbuild: true }\n", ["node-liblzma"], "ignore-optional"),
    ).toThrow("does not use block-style YAML");
  });
});
