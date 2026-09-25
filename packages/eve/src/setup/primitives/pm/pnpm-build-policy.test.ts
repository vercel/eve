import { describe, expect, it } from "vitest";

import { withPnpmBuildPolicy, withPnpmOptionalDependencyDefaults } from "./pnpm-build-policy.js";

describe("pnpm optional dependency defaults", () => {
  const packages = ["@mongodb-js/zstd", "node-liblzma"];

  it("adds defaults to a fresh workspace and is idempotent", () => {
    const next = withPnpmOptionalDependencyDefaults("", packages);
    expect(next).toBe('ignoredOptionalDependencies:\n  - "@mongodb-js/zstd"\n  - "node-liblzma"\n');
    expect(withPnpmOptionalDependencyDefaults(next, packages)).toBe(next);
  });

  it.each(["true", "false"])(
    "preserves an explicit %s build decision while defaulting only missing packages",
    (decision) => {
      const source = `packages:\n  - apps/*\nallowBuilds:\n  "@mongodb-js/zstd": ${decision}\n  esbuild: true\n`;
      expect(withPnpmOptionalDependencyDefaults(source, packages)).toBe(
        `${source}\nignoredOptionalDependencies:\n  - "node-liblzma"\n`,
      );
    },
  );

  it("preserves mixed existing decisions without rewriting the file", () => {
    const source =
      'allowBuilds:\n  "@mongodb-js/zstd": false\nignoredOptionalDependencies:\n  - node-liblzma\n  - cbor-extract\n';
    expect(withPnpmOptionalDependencyDefaults(source, packages)).toBe(source);
  });

  it("preserves explicit decisions in older pnpm policy lists", () => {
    const source =
      'onlyBuiltDependencies:\n  - "@mongodb-js/zstd"\nignoredBuiltDependencies:\n  - node-liblzma\n';
    expect(withPnpmOptionalDependencyDefaults(source, packages)).toBe(source);
  });

  it("fails safely on unsupported policy syntax", () => {
    expect(() =>
      withPnpmOptionalDependencyDefaults("allowBuilds: { esbuild: true }\n", packages),
    ).toThrow("does not use block-style YAML");
  });
});

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
