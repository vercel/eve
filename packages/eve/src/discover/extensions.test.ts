import { describe, expect, it } from "vitest";

import {
  locateExtensionMount,
  locateExtensionMountPackage,
  mountNamespace,
} from "#discover/extensions.js";
import { createModuleSourceRef } from "#discover/manifest.js";
import { createMemoryProjectSource } from "#discover/project-source.js";

describe("mountNamespace", () => {
  it("derives the namespace from the mount filename", () => {
    expect(mountNamespace("extensions/crm.ts")).toBe("crm");
    expect(mountNamespace("extensions/toolkit.mts")).toBe("toolkit");
  });
});

describe("locateExtensionMountPackage", () => {
  it("resolves a package-local built-in extension without a compatibility manifest", async () => {
    const appRoot = "/repo/apps/agent";
    const agentRoot = `${appRoot}/agent`;
    const packageRoot = `${appRoot}/node_modules/eve`;
    const source = createMemoryProjectSource({
      files: {
        [`${agentRoot}/extensions/selfmod.ts`]:
          'export { default } from "eve/self-modification";\n',
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "eve",
          eve: {
            builtInExtensions: {
              "./self-modification": { dist: "dist/src/self-modification/extension" },
            },
          },
        }),
      },
    });

    const result = await locateExtensionMount({
      source,
      agentRoot,
      appRoot,
      mount: createModuleSourceRef({ logicalPath: "extensions/selfmod.ts" }),
      namespace: "selfmod",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.location).toMatchObject({
      packageName: "eve",
      packageRoot,
      sourceRoot: `${packageRoot}/dist/src/self-modification/extension`,
      specifier: "eve/self-modification",
    });
  });

  it("resolves a built-in extension mounted from inside the eve package by self-reference", async () => {
    const packageRoot = "/repo/packages/eve";
    const agentRoot = `${packageRoot}/src/example/extension`;
    const source = createMemoryProjectSource({
      files: {
        [`${agentRoot}/subagents/coder/extensions/code.ts`]:
          'import code from "eve/extensions/code";\nexport default code({});\n',
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "eve",
          eve: {
            builtInExtensions: {
              "./extensions/code": { dist: "dist/src/extensions/code/extension" },
            },
          },
        }),
      },
    });

    const result = await locateExtensionMount({
      source,
      agentRoot: `${agentRoot}/subagents/coder`,
      appRoot: packageRoot,
      mount: createModuleSourceRef({ logicalPath: "extensions/code.ts" }),
      namespace: "code",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.location).toMatchObject({
      packageRoot,
      sourceRoot: `${packageRoot}/dist/src/extensions/code/extension`,
    });
  });

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
