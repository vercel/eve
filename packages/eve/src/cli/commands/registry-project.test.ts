import { describe, expect, it } from "vitest";

import { addWebRegistryTsconfig } from "./registry-project.js";

describe("addWebRegistryTsconfig", () => {
  it("adds the shadcn import alias while preserving JSONC", () => {
    const source = `{
  // Keep agent files in this project.
  "compilerOptions": {
    "types": ["node"],
    "plugins": [{ "name": "custom" }],
  },
  "include": ["agent/**/*.ts"],
}
`;

    const updated = addWebRegistryTsconfig(source, "/project/tsconfig.json");

    expect(updated).toContain("// Keep agent files in this project.");
    expect(updated).toContain('"types": [');
    expect(updated).toContain('"node"');
    expect(updated).toContain('"@/*": [');
    expect(updated).toContain('"./*"');
    expect(updated).toContain('"agent/**/*.ts"');
    expect(updated).toContain('"**/*.tsx"');
    expect(updated).toContain('"name": "custom"');
    expect(updated).toContain('"name": "next"');
  });

  it("does not duplicate an existing compatible alias", () => {
    const source = '{"compilerOptions":{"paths":{"@/*":["./*"]}}}\n';

    const updated = addWebRegistryTsconfig(source, "/project/tsconfig.json");

    expect(updated.match(/"@\/\*"/gu)).toHaveLength(1);
  });

  it("rejects an incompatible existing alias", () => {
    const source = '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}\n';

    expect(() => addWebRegistryTsconfig(source, "/project/tsconfig.json")).toThrow(
      "already defines @/* without mapping it to ./*",
    );
  });
});
