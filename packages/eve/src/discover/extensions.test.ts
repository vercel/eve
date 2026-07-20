import { describe, expect, it } from "vitest";

import {
  locateExtensionMountPackage,
  mountNamespace,
  packageStateNamespace,
} from "#discover/extensions.js";
import { createModuleSourceRef } from "#discover/manifest.js";
import { createMemoryProjectSource } from "#discover/project-source.js";

describe("mountNamespace", () => {
  it("derives the namespace from the mount filename", () => {
    expect(mountNamespace("extensions/crm.ts")).toBe("crm");
    expect(mountNamespace("extensions/toolkit.mts")).toBe("toolkit");
  });
});

describe("packageStateNamespace", () => {
  it("keeps a plain package name", () => {
    expect(packageStateNamespace("toolkit-extension")).toBe("toolkit-extension");
  });

  it("flattens a scoped package name", () => {
    expect(packageStateNamespace("@acme/crm")).toBe("acme-crm");
  });

  it("replaces characters that are unsafe in a key segment", () => {
    expect(packageStateNamespace("@acme/crm.tools")).toBe("acme-crm.tools");
  });

  it("falls back to a stable token for a degenerate name", () => {
    expect(packageStateNamespace("@")).toBe("extension");
  });
});

describe("locateExtensionMountPackage", () => {
  it("resolves source and dist roots before the distribution exists", async () => {
    const appRoot = "/repo/apps/agent";
    const agentRoot = `${appRoot}/agent`;
    const packageRoot = `${appRoot}/node_modules/@acme/crm`;
    const source = createMemoryProjectSource({
      files: {
        [`${agentRoot}/extensions/crm.ts`]: 'export { default } from "@acme/crm";\n',
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "@acme/crm",
          eve: { extension: { source: "extension", dist: "dist/extension" } },
        }),
      },
    });

    const result = await locateExtensionMountPackage({
      source,
      agentRoot,
      appRoot,
      mount: createModuleSourceRef({ logicalPath: "extensions/crm.ts" }),
      namespace: "crm",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.location).toMatchObject({
      authoredSourceRoot: `${packageRoot}/extension`,
      distRoot: `${packageRoot}/dist/extension`,
      packageName: "@acme/crm",
      packageRoot,
      specifier: "@acme/crm",
    });
  });
});
