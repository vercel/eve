import { describe, expect, it } from "vitest";

import {
  buildNodeEsmCompatBanner,
  createNodeEsmCompatBannerPlugin,
} from "#internal/node-esm-compat-banner.js";

type TestProgram = Parameters<typeof buildNodeEsmCompatBanner>[0];
type TestPlugin = ReturnType<typeof createNodeEsmCompatBannerPlugin>;

const EMPTY_PROGRAM: TestProgram = { body: [] };

function programWithTopLevelBindings(...names: string[]): TestProgram {
  return {
    body: [
      {
        type: "VariableDeclaration",
        declarations: names.map((name) => ({ id: { type: "Identifier", name } })),
      },
    ],
  };
}

function renderChunk(
  plugin: TestPlugin,
  code: string,
  program: TestProgram = EMPTY_PROGRAM,
  chunk?: { readonly fileName?: string },
) {
  return plugin.renderChunk.call({ parse: () => program }, code, chunk);
}

describe("buildNodeEsmCompatBanner", () => {
  it("emits both path globals when the chunk declares neither", () => {
    const banner = buildNodeEsmCompatBanner(EMPTY_PROGRAM);

    expect(banner).toContain("const __filename = __eveFileURLToPath(import.meta.url);");
    expect(banner).toContain("const __dirname = __eveDirname(__filename);");
    expect(banner).not.toContain("__eveCreateRequire");
  });

  it("includes the require shim when requested", () => {
    const banner = buildNodeEsmCompatBanner(EMPTY_PROGRAM, { includeRequire: true });

    expect(banner).toContain("const require = __eveCreateRequire(import.meta.url);");
  });

  it("omits __dirname when the chunk already declares it at the top level", () => {
    // Regression: previously the banner unconditionally prepended
    // `const __dirname = ...`, producing `SyntaxError: Identifier
    // '__dirname' has already been declared` when bundled output
    // re-declared the path global itself.
    const banner = buildNodeEsmCompatBanner(programWithTopLevelBindings("__filename", "__dirname"));

    expect(banner).not.toContain("__dirname");
    expect(banner).not.toContain("__filename");
    // With both globals already declared we emit nothing.
    expect(banner).toBe("");
  });

  it("emits only the missing path global", () => {
    const banner = buildNodeEsmCompatBanner(programWithTopLevelBindings("__dirname"));

    expect(banner).toContain("const __filename = __eveFileURLToPath(import.meta.url);");
    expect(banner).not.toContain("const __dirname = __eveDirname(__filename);");
    expect(banner).not.toContain('from "node:path"');
  });

  it("does not read a chunk-provided __filename before it initializes", () => {
    const banner = buildNodeEsmCompatBanner(programWithTopLevelBindings("__filename"));

    expect(banner).not.toContain("const __filename");
    expect(banner).toContain(
      "const __dirname = __eveDirname(__eveFileURLToPath(import.meta.url));",
    );
  });

  it("omits the require shim when the chunk binds require", () => {
    const banner = buildNodeEsmCompatBanner(programWithTopLevelBindings("require"), {
      includeRequire: true,
    });

    expect(banner).not.toContain("__eveCreateRequire");
    expect(banner).not.toContain("const require");
  });

  it("does not treat bundler-suffixed bindings as compatibility globals", () => {
    const banner = buildNodeEsmCompatBanner(
      programWithTopLevelBindings("__filename$1", "__dirname$1", "require$1"),
      { includeRequire: true },
    );

    expect(banner).toContain("const __filename = __eveFileURLToPath(import.meta.url);");
    expect(banner).toContain("const __dirname = __eveDirname(__filename);");
    expect(banner).toContain("const require = __eveCreateRequire(import.meta.url);");
  });

  it("ignores nested declarations inside functions", () => {
    const banner = buildNodeEsmCompatBanner({
      body: [
        {
          type: "FunctionDeclaration",
          body: {
            type: "BlockStatement",
            body: [
              {
                type: "VariableDeclaration",
                declarations: [{ id: { type: "Identifier", name: "__dirname" } }],
              },
            ],
          },
        },
      ],
    });

    // The chunk has not bound `__dirname` at the top level, so the
    // banner must still provide it.
    expect(banner).toContain("const __dirname = __eveDirname(__filename);");
    expect(banner).toContain("const __filename = __eveFileURLToPath(import.meta.url);");
  });
});

describe("createNodeEsmCompatBannerPlugin", () => {
  it("omits bindings declared later in a top-level variable list", () => {
    const plugin = createNodeEsmCompatBannerPlugin({ includeRequire: true });
    const chunk =
      "const logs = getLogs(), require = createRequire(import.meta.url), __filename = fileURLToPath(import.meta.url), __dirname = dirname(__filename);";

    expect(
      renderChunk(
        plugin,
        chunk,
        programWithTopLevelBindings("logs", "require", "__filename", "__dirname"),
      ),
    ).toBeNull();
  });

  it("prepends the banner to chunks that need it", () => {
    const plugin = createNodeEsmCompatBannerPlugin();
    const code = 'export const value = "noop";';
    const result = renderChunk(plugin, code, EMPTY_PROGRAM, { fileName: "agent.mjs" });

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
    const result = renderChunk(plugin, code);

    expect(result?.map.mappings).toBe(";;;;AAAA;AACA");
  });

  it("returns null when the chunk already provides every binding", () => {
    const plugin = createNodeEsmCompatBannerPlugin();
    const chunk = [
      "const __filename = '/x';",
      "const __dirname = '/';",
      'export const value = "noop";',
    ].join("\n");

    expect(
      renderChunk(plugin, chunk, programWithTopLevelBindings("__filename", "__dirname")),
    ).toBeNull();
  });
});
