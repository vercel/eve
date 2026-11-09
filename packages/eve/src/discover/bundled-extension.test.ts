import { sourcesOf } from "#discover/manifest.js";
import { describe, expect, it } from "vitest";

import { createBundledExtensionMount } from "#compiler/bundled-extension.js";
import { discoverBundledExtension } from "#discover/bundled-extension.js";
import { createMemoryProjectSource } from "#discover/project-source.js";

describe("discoverBundledExtension", () => {
  it("discovers the complete extension tree without declared file entries", async () => {
    const mount = createBundledExtensionMount({
      entryPath: "/package/extension/extension.ts",
      importSpecifier: "eve/example",
      config: {},
      namespace: "example",
      sourceDirectory: "/package/extension",
    });
    const result = await discoverBundledExtension({
      mount,
      source: createMemoryProjectSource({
        files: {
          "/package/extension/instructions.ts": "export default {};",
          "/package/extension/tools/first.ts": "export default {};",
          "/package/extension/tools/nested/second.ts": "export default {};",
        },
      }),
    });

    expect(result.diagnostics).toEqual([]);
    expect(
      sourcesOf(result.mount.manifest, "instructions").map((source) => source.logicalPath),
    ).toEqual(["instructions.ts"]);
    expect(
      sourcesOf(result.mount.manifest, "tool")
        .map((source) => source.logicalPath)
        .sort(),
    ).toEqual(["tools/first.ts", "tools/nested/second.ts"]);
    expect(result.mount.programmaticDeclaration).toEqual({
      entryPath: "/package/extension/extension.ts",
      importSpecifier: "eve/example",
      config: {},
      logicalPath: "extensions/example.ts",
      sourceId: `${mount.declaration.id}:extensions/example.ts`,
    });
  });
});
