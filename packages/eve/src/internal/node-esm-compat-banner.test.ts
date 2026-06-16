import { describe, expect, it } from "vitest";

import {
  buildNodeEsmCompatBanner,
  createNodeEsmCompatBannerPlugin,
} from "#internal/node-esm-compat-banner.js";

describe("buildNodeEsmCompatBanner", () => {
  it("emits both path globals when the chunk declares neither", () => {
    const banner = buildNodeEsmCompatBanner('console.log("noop");');

    expect(banner).toContain("const __filename = __eveFileURLToPath(import.meta.url);");
    expect(banner).toContain("const __dirname = __eveDirname(__filename);");
    expect(banner).not.toContain("__eveCreateRequire");
  });

  it("includes the require shim when requested", () => {
    const banner = buildNodeEsmCompatBanner('console.log("noop");', { includeRequire: true });

    expect(banner).toContain("const require = __eveCreateRequire(import.meta.url);");
  });

  it("omits __dirname when the chunk already declares it at the top level", () => {
    // Regression: previously the banner unconditionally prepended
    // `const __dirname = ...`, producing `SyntaxError: Identifier
    // '__dirname' has already been declared` when bundled output
    // re-declared the path global itself.
    const chunk = [
      'import { fileURLToPath } from "node:url";',
      'import { dirname } from "node:path";',
      "const __filename = fileURLToPath(import.meta.url);",
      "const __dirname = dirname(__filename);",
      "",
      'export const value = "noop";',
    ].join("\n");

    const banner = buildNodeEsmCompatBanner(chunk);

    expect(banner).not.toContain("__dirname");
    expect(banner).not.toContain("__filename");
    // With both globals already declared we emit nothing.
    expect(banner).toBe("");
  });

  it("emits only the missing path global", () => {
    const chunk = ["var __dirname = somethingElse;", 'export const value = "noop";'].join("\n");

    const banner = buildNodeEsmCompatBanner(chunk);

    expect(banner).toContain("const __filename = __eveFileURLToPath(import.meta.url);");
    expect(banner).not.toContain("const __dirname = __eveDirname(__filename);");
    expect(banner).not.toContain('from "node:path"');
  });

  it("omits the require shim when the chunk binds require", () => {
    const chunk = [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      'export const value = "noop";',
    ].join("\n");

    const banner = buildNodeEsmCompatBanner(chunk, { includeRequire: true });

    expect(banner).not.toContain("__eveCreateRequire");
    expect(banner).not.toContain("const require");
  });

  it("ignores nested declarations inside functions", () => {
    const chunk = [
      "function inner() {",
      "  const __dirname = 'shadowed';",
      "  return __dirname;",
      "}",
      "export { inner };",
    ].join("\n");

    const banner = buildNodeEsmCompatBanner(chunk);

    // The chunk has not bound `__dirname` at the top level, so the
    // banner must still provide it.
    expect(banner).toContain("const __dirname = __eveDirname(__filename);");
    expect(banner).toContain("const __filename = __eveFileURLToPath(import.meta.url);");
  });
});

describe("createNodeEsmCompatBannerPlugin", () => {
  it("prepends the banner to chunks that need it", () => {
    const plugin = createNodeEsmCompatBannerPlugin();
    const code = 'export const value = "noop";';
    const result = plugin.renderChunk(code, { fileName: "agent.mjs" });

    expect(result).not.toBeNull();
    expect(result?.code).toMatch(/^import \{ fileURLToPath as __eveFileURLToPath \}/);
    expect(result?.code).toContain('export const value = "noop";');
    expect(result?.map).toEqual({
      version: 3,
      sources: ["agent.mjs"],
      sourcesContent: [code],
      names: [],
      mappings: ";;;;AAAA",
    });
  });

  it("maps original chunk lines after the prepended banner", () => {
    const plugin = createNodeEsmCompatBannerPlugin();
    const code = ['const value = "noop";', "export { value };"].join("\n");
    const result = plugin.renderChunk(code);

    expect(result?.map.mappings).toBe(";;;;AAAA;AACA");
  });

  it("returns null when the chunk already provides every binding", () => {
    const plugin = createNodeEsmCompatBannerPlugin();
    const chunk = [
      "const __filename = '/x';",
      "const __dirname = '/';",
      'export const value = "noop";',
    ].join("\n");

    expect(plugin.renderChunk(chunk)).toBeNull();
  });
});
