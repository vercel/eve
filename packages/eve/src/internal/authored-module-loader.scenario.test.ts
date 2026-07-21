import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import {
  bundleAuthoredModuleForGeneration,
  loadAuthoredModuleNamespace,
} from "#internal/authored-module-loader.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("loadAuthoredModuleNamespace", () => {
  const scenarioApp = useScenarioApp();

  it("preserves cached channel identity for relative channel imports", async () => {
    const app = await scenarioApp({
      files: {
        "agent/channels/support.ts": [
          'export default { marker: "source-channel-instance" };',
          "",
        ].join("\n"),
        "agent/tools/use_support_channel.ts": [
          'import supportChannel from "../channels/support";',
          "",
          "export const result = supportChannel.marker;",
          "",
        ].join("\n"),
      },
      name: "cached-relative-channel-import",
    });
    const cache = new Map<string, unknown>();
    const cacheKey = "__eveChannelModuleCache__";
    const globals = globalThis as Record<string, unknown>;
    const previousCache = globals[cacheKey];

    try {
      const supportChannelPath = await realpath(
        join(app.appRoot, "agent", "channels", "support.ts"),
      );
      cache.set(supportChannelPath, { marker: "cached-channel-instance" });
      globals[cacheKey] = cache;

      const moduleNamespace = await loadAuthoredModuleNamespace(
        join(app.appRoot, "agent", "tools", "use_support_channel.ts"),
      );

      expect(moduleNamespace.result).toBe("cached-channel-instance");
    } finally {
      if (previousCache === undefined) {
        delete globals[cacheKey];
      } else {
        globals[cacheKey] = previousCache;
      }
    }
  });

  it("resolves extensionless relative imports with dotted TypeScript basenames", async () => {
    const app = await scenarioApp({
      files: {
        "agent/tools/use_schema.ts": [
          'import { schemaValue } from "./mock-registry.schemas";',
          "",
          "export const result = schemaValue;",
          "",
        ].join("\n"),
        "agent/tools/mock-registry.schemas.ts": [
          'export const schemaValue = "local-dotted-basename";',
          "",
        ].join("\n"),
      },
      name: "local-dotted-basename-import",
    });

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(app.appRoot, "agent", "tools", "use_schema.ts"),
    );

    expect(moduleNamespace.result).toBe("local-dotted-basename");
  });

  it("resolves extensionless relative directory imports to index modules", async () => {
    const app = await scenarioApp({
      files: {
        "agent/tools/use_helpers.ts": [
          'import { helperValue } from "./helpers";',
          "",
          "export const result = helperValue;",
          "",
        ].join("\n"),
        "agent/tools/helpers/index.ts": ['export const helperValue = "directory-index";', ""].join(
          "\n",
        ),
      },
      name: "directory-index-import",
    });

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(app.appRoot, "agent", "tools", "use_helpers.ts"),
    );

    expect(moduleNamespace.result).toBe("directory-index");
  });

  it("resolves extensionless CommonJS requires with dotted JavaScript basenames", async () => {
    const app = await scenarioApp({
      files: {
        "agent/channels/api/contact-sales/webhook.ts": [
          'import { readDottedValue } from "@repo/enrichment/dotted";',
          "",
          "export const result = readDottedValue();",
          "",
        ].join("\n"),
      },
      name: "dependency-dotted-basename-require",
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-dependency-dotted-basename-"));

    try {
      const packageRoot = join(workspaceRoot, "packages", "enrichment");
      const packageNodeModules = join(packageRoot, "node_modules", "fixture-dotted-cjs-dep");
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await mkdir(packageNodeModules, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            exports: {
              "./dotted": "./src/dotted.ts",
            },
            name: "@repo/enrichment",
            type: "module",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageRoot, "src", "dotted.ts"),
        [
          'import dottedDependency from "fixture-dotted-cjs-dep";',
          "",
          "export function readDottedValue() {",
          "  return dottedDependency.value;",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(packageNodeModules, "package.json"),
        JSON.stringify(
          {
            main: "index.cjs",
            name: "fixture-dotted-cjs-dep",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageNodeModules, "index.cjs"),
        'module.exports = require("./Reflect.getPrototypeOf");\n',
      );
      await writeFile(
        join(packageNodeModules, "Reflect.getPrototypeOf.js"),
        'module.exports = { value: "cjs-dotted-basename" };\n',
      );

      await mkdir(join(app.appRoot, "node_modules", "@repo"), { recursive: true });
      await symlink(
        packageRoot,
        join(app.appRoot, "node_modules", "@repo", "enrichment"),
        "junction",
      );

      const moduleNamespace = await loadAuthoredModuleNamespace(
        join(app.appRoot, "agent", "channels", "api", "contact-sales", "webhook.ts"),
      );

      expect(moduleNamespace.result).toBe("cjs-dotted-basename");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("bundles symlinked workspace packages that export TypeScript source", async () => {
    const app = await scenarioApp({
      files: {
        "agent/channels/api/contact-sales/webhook.ts": [
          'import { searchLinkedInProfile } from "@repo/enrichment/exa-linkedin";',
          "",
          "export const result = searchLinkedInProfile();",
          "",
        ].join("\n"),
      },
      name: "workspace-source-package",
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-workspace-source-package-"));

    try {
      const packageRoot = join(workspaceRoot, "packages", "enrichment");
      const packageNodeModules = join(packageRoot, "node_modules", "cjs-dep");
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await mkdir(packageNodeModules, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            exports: {
              "./exa-linkedin": "./src/exa-linkedin.ts",
            },
            name: "@repo/enrichment",
            type: "module",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageRoot, "src", "exa-linkedin.ts"),
        [
          'import * as cjs from "cjs-dep";',
          'import { getExaClient } from "./exa-client";',
          "",
          "cjs.configure();",
          "export function searchLinkedInProfile() {",
          "  return getExaClient();",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(packageRoot, "src", "exa-client.ts"),
        'export function getExaClient() { return "linked"; }\n',
      );
      await writeFile(
        join(packageNodeModules, "package.json"),
        JSON.stringify({ main: "index.cjs", name: "cjs-dep" }, null, 2),
      );
      await writeFile(
        join(packageNodeModules, "index.cjs"),
        [
          "module.exports = { configure() {",
          '  require("stream");',
          '  if (typeof __dirname !== "string") throw new Error("__dirname missing");',
          "} };",
          "",
        ].join("\n"),
      );

      await mkdir(join(app.appRoot, "node_modules", "@repo"), { recursive: true });
      await symlink(
        packageRoot,
        join(app.appRoot, "node_modules", "@repo", "enrichment"),
        "junction",
      );

      const moduleNamespace = await loadAuthoredModuleNamespace(
        join(app.appRoot, "agent", "channels", "api", "contact-sales", "webhook.ts"),
      );

      expect(moduleNamespace.result).toBe("linked");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("does not collide with authored modules that already declare __dirname", async () => {
    // Regression: the Node ESM compatibility banner used to unconditionally
    // prepend `const __dirname = ...` / `const __filename = ...` /
    // `const require = ...` to every bundled chunk. When the authored
    // source already declared one of those identifiers at the top level
    // the bundled `.mjs` failed to load with
    // `SyntaxError: Identifier '__dirname' has already been declared`.
    const app = await scenarioApp({
      files: {
        "agent/channels/api/already-declared/webhook.ts": [
          'import { createRequire } from "node:module";',
          'import { dirname } from "node:path";',
          'import { fileURLToPath } from "node:url";',
          "",
          "const __filename = fileURLToPath(import.meta.url);",
          "const __dirname = dirname(__filename);",
          "const require = createRequire(import.meta.url);",
          "",
          "export const result = {",
          "  dirname: typeof __dirname,",
          "  filename: typeof __filename,",
          "  require: typeof require,",
          "};",
          "",
        ].join("\n"),
      },
      name: "authored-module-redeclares-path-globals",
    });

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(app.appRoot, "agent", "channels", "api", "already-declared", "webhook.ts"),
    );

    expect(moduleNamespace.result).toEqual({
      dirname: "string",
      filename: "string",
      require: "function",
    });
  });

  it("uses a symlinked workspace package's tsconfig paths when bundling its source", async () => {
    const app = await scenarioApp({
      files: {
        "agent/channels/api/contact-sales/webhook.ts": [
          'import { searchLinkedInProfile } from "@repo/enrichment/exa-linkedin";',
          "",
          "export const result = searchLinkedInProfile();",
          "",
        ].join("\n"),
        "tsconfig.json": JSON.stringify(
          {
            compilerOptions: {
              baseUrl: ".",
              paths: {
                "@app/*": ["agent/*"],
              },
            },
          },
          null,
          2,
        ),
      },
      name: "workspace-package-local-tsconfig-paths",
    });
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "eve-workspace-package-local-tsconfig-paths-"),
    );

    try {
      const packageRoot = join(workspaceRoot, "packages", "enrichment");
      await mkdir(join(packageRoot, "src", "internal"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            exports: {
              "./exa-linkedin": "./src/exa-linkedin.ts",
            },
            name: "@repo/enrichment",
            type: "module",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageRoot, "tsconfig.json"),
        [
          "{",
          "  // Package-local aliases should be resolved from this config.",
          '  "compilerOptions": {',
          '    "baseUrl": ".",',
          '    "paths": {',
          '      "@enrichment/*": ["src/internal/*"],',
          "    },",
          "  },",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(packageRoot, "src", "exa-linkedin.ts"),
        [
          'import { getExaClient } from "@enrichment/exa-client";',
          "",
          "export function searchLinkedInProfile() {",
          "  return getExaClient();",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(packageRoot, "src", "internal", "exa-client.ts"),
        'export function getExaClient() { return "package-local-paths"; }\n',
      );

      await mkdir(join(app.appRoot, "node_modules", "@repo"), { recursive: true });
      await symlink(
        packageRoot,
        join(app.appRoot, "node_modules", "@repo", "enrichment"),
        "junction",
      );

      const moduleNamespace = await loadAuthoredModuleNamespace(
        join(app.appRoot, "agent", "channels", "api", "contact-sales", "webhook.ts"),
      );

      expect(moduleNamespace.result).toBe("package-local-paths");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("keeps configured dependencies external when they are imported from workspace packages", async () => {
    const app = await scenarioApp({
      files: {
        "agent/channels/api/contact-sales/webhook.ts": [
          'import { readExternalValue } from "@repo/enrichment/external-value";',
          "",
          "export const result = readExternalValue();",
          "",
        ].join("\n"),
      },
      name: "workspace-package-configured-external",
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-workspace-configured-external-"));

    try {
      const packageRoot = join(workspaceRoot, "packages", "enrichment");
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            exports: {
              "./external-value": "./src/external-value.ts",
            },
            name: "@repo/enrichment",
            type: "module",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageRoot, "src", "external-value.ts"),
        [
          'import externalOnly from "external-only";',
          "",
          "export function readExternalValue() {",
          "  return externalOnly.value;",
          "}",
          "",
        ].join("\n"),
      );

      const externalPackageRoot = join(app.appRoot, "node_modules", "external-only");
      await mkdir(externalPackageRoot, { recursive: true });
      await writeFile(
        join(externalPackageRoot, "package.json"),
        JSON.stringify({ main: "index.cjs", name: "external-only" }, null, 2),
      );
      await writeFile(
        join(externalPackageRoot, "index.cjs"),
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          "module.exports = {",
          '  value: fs.readFileSync(path.join(__dirname, "payload.txt"), "utf8").trim(),',
          "};",
          "",
        ].join("\n"),
      );
      await writeFile(join(externalPackageRoot, "payload.txt"), "externalized\n");

      await mkdir(join(app.appRoot, "node_modules", "@repo"), { recursive: true });
      await symlink(
        packageRoot,
        join(app.appRoot, "node_modules", "@repo", "enrichment"),
        "junction",
      );

      const moduleNamespace = await loadAuthoredModuleNamespace(
        join(app.appRoot, "agent", "channels", "api", "contact-sales", "webhook.ts"),
        { externalDependencies: ["external-only"] },
      );

      expect(moduleNamespace.result).toBe("externalized");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("bundles unconfigured dependencies imported from workspace packages", async () => {
    const app = await scenarioApp({
      files: {
        "agent/channels/api/contact-sales/webhook.ts": [
          'import { readExternalValue } from "@repo/enrichment/external-value";',
          "",
          "export const result = readExternalValue();",
          "",
        ].join("\n"),
      },
      name: "workspace-package-bundled-dependency",
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-workspace-bundled-dependency-"));

    try {
      const packageRoot = join(workspaceRoot, "packages", "enrichment");
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            exports: {
              "./external-value": "./src/external-value.ts",
            },
            name: "@repo/enrichment",
            type: "module",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageRoot, "src", "external-value.ts"),
        [
          'import kmsClient from "@aws-sdk/client-kms";',
          "",
          "export function readExternalValue() {",
          "  return kmsClient.value;",
          "}",
          "",
        ].join("\n"),
      );

      const externalPackageRoot = join(app.appRoot, "node_modules", "@aws-sdk", "client-kms");
      await mkdir(externalPackageRoot, { recursive: true });
      await writeFile(
        join(externalPackageRoot, "package.json"),
        JSON.stringify({ main: "index.cjs", name: "@aws-sdk/client-kms" }, null, 2),
      );
      await writeFile(
        join(externalPackageRoot, "index.cjs"),
        'module.exports = require("./runtimeConfig.shared");\n',
      );
      await writeFile(
        join(externalPackageRoot, "runtimeConfig.shared.js"),
        "module.exports = { value: 'bundled-dependency' };\n",
      );

      await mkdir(join(app.appRoot, "node_modules", "@repo"), { recursive: true });
      await symlink(
        packageRoot,
        join(app.appRoot, "node_modules", "@repo", "enrichment"),
        "junction",
      );

      const moduleNamespace = await loadAuthoredModuleNamespace(
        join(app.appRoot, "agent", "channels", "api", "contact-sales", "webhook.ts"),
      );

      expect(moduleNamespace.result).toBe("bundled-dependency");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  // pnpm's store layout: an installed package's dependencies are store
  // siblings, only resolvable from the package's real location. The compiled
  // module map imports extension modules by literal path through the app's
  // node_modules symlink (a dev-generation snapshot preserves that symlink
  // while relocating every importer path), so bare imports must resolve from
  // the module's realpath.
  async function createStoreSiblingInstall(input: {
    readonly appRoot: string;
    readonly storeRoot: string;
    readonly consumerDecoy?: boolean;
  }): Promise<void> {
    const storeNodeModules = join(input.storeRoot, "node_modules");
    const packageRoot = join(storeNodeModules, "gadget-extension");
    await mkdir(join(packageRoot, "extension", "tools"), { recursive: true });
    await mkdir(join(storeNodeModules, "store-sibling"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "gadget-extension", type: "module" }, null, 2),
    );
    await writeFile(
      join(packageRoot, "extension", "tools", "echo.ts"),
      ['import sibling from "store-sibling";', "", "export const result = sibling.value;", ""].join(
        "\n",
      ),
    );
    await writeFile(
      join(storeNodeModules, "store-sibling", "package.json"),
      JSON.stringify({ main: "index.cjs", name: "store-sibling" }, null, 2),
    );
    await writeFile(
      join(storeNodeModules, "store-sibling", "index.cjs"),
      "module.exports = { value: 'store-sibling-value' };\n",
    );

    await mkdir(join(input.appRoot, "node_modules"), { recursive: true });
    await symlink(packageRoot, join(input.appRoot, "node_modules", "gadget-extension"), "junction");

    if (input.consumerDecoy === true) {
      const decoyRoot = join(input.appRoot, "node_modules", "store-sibling");
      await mkdir(decoyRoot, { recursive: true });
      await writeFile(
        join(decoyRoot, "package.json"),
        JSON.stringify({ main: "index.cjs", name: "store-sibling" }, null, 2),
      );
      await writeFile(join(decoyRoot, "index.cjs"), "module.exports = { value: 'decoy-value' };\n");
    }
  }

  it("inlines store-sibling dependencies of modules reached through literal symlink paths", async () => {
    const app = await scenarioApp({
      files: {
        "agent/tools/use_echo.ts": [
          'import { result } from "../../node_modules/gadget-extension/extension/tools/echo.ts";',
          "",
          "export const toolResult = result;",
          "",
        ].join("\n"),
      },
      name: "store-sibling-generation",
    });
    const storeRoot = await mkdtemp(join(tmpdir(), "eve-store-sibling-generation-"));

    try {
      await createStoreSiblingInstall({ appRoot: app.appRoot, storeRoot });

      const code = await bundleAuthoredModuleForGeneration(
        join(app.appRoot, "agent", "tools", "use_echo.ts"),
      );

      expect(code).toContain("store-sibling-value");
      expect(code).not.toMatch(/from\s*["']store-sibling["']/);
    } finally {
      await rm(storeRoot, { force: true, recursive: true });
    }
  });

  it("prefers a package's store sibling over a consumer copy of the same dependency", async () => {
    const app = await scenarioApp({
      files: {
        "agent/tools/use_echo.ts": [
          'import { result } from "../../node_modules/gadget-extension/extension/tools/echo.ts";',
          "",
          "export const toolResult = result;",
          "",
        ].join("\n"),
      },
      name: "store-sibling-precedence",
    });
    const storeRoot = await mkdtemp(join(tmpdir(), "eve-store-sibling-precedence-"));

    try {
      await createStoreSiblingInstall({ appRoot: app.appRoot, consumerDecoy: true, storeRoot });

      const code = await bundleAuthoredModuleForGeneration(
        join(app.appRoot, "agent", "tools", "use_echo.ts"),
      );

      expect(code).toContain("store-sibling-value");
      expect(code).not.toContain("decoy-value");
    } finally {
      await rm(storeRoot, { force: true, recursive: true });
    }
  });

  it("resolves store siblings for generation bundles entered at node_modules paths", async () => {
    const app = await scenarioApp({
      files: {
        "agent/instructions.md": "Store-sibling entry scenario.\n",
      },
      name: "store-sibling-entry",
    });
    const storeRoot = await mkdtemp(join(tmpdir(), "eve-store-sibling-entry-"));

    try {
      await createStoreSiblingInstall({ appRoot: app.appRoot, consumerDecoy: true, storeRoot });

      const code = await bundleAuthoredModuleForGeneration(
        join(app.appRoot, "node_modules", "gadget-extension", "extension", "tools", "echo.ts"),
      );

      expect(code).toContain("store-sibling-value");
      expect(code).not.toContain("decoy-value");
    } finally {
      await rm(storeRoot, { force: true, recursive: true });
    }
  });

  it("keeps configured dependency subpaths importable after externalizing them", async () => {
    const app = await scenarioApp({
      files: {
        "agent/channels/api/contact-sales/webhook.ts": [
          'import { readExternalValue } from "@repo/enrichment/external-value";',
          "",
          "export const result = readExternalValue();",
          "",
        ].join("\n"),
      },
      name: "workspace-package-configured-external-subpath",
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-workspace-external-subpath-"));

    try {
      const packageRoot = join(workspaceRoot, "packages", "enrichment");
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            exports: {
              "./external-value": "./src/external-value.ts",
            },
            name: "@repo/enrichment",
            type: "module",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageRoot, "src", "external-value.ts"),
        [
          'import externalTags from "external-only/ext/tags";',
          "",
          "export function readExternalValue() {",
          "  return externalTags.value;",
          "}",
          "",
        ].join("\n"),
      );

      const externalPackageRoot = join(app.appRoot, "node_modules", "external-only");
      await mkdir(join(externalPackageRoot, "ext"), { recursive: true });
      await writeFile(
        join(externalPackageRoot, "package.json"),
        JSON.stringify({ main: "index.js", name: "external-only", type: "commonjs" }, null, 2),
      );
      await writeFile(
        join(externalPackageRoot, "ext", "tags.js"),
        "module.exports = { value: 'external-subpath' };\n",
      );

      await mkdir(join(app.appRoot, "node_modules", "@repo"), { recursive: true });
      await symlink(
        packageRoot,
        join(app.appRoot, "node_modules", "@repo", "enrichment"),
        "junction",
      );

      const moduleNamespace = await loadAuthoredModuleNamespace(
        join(app.appRoot, "agent", "channels", "api", "contact-sales", "webhook.ts"),
        { externalDependencies: ["external-only"] },
      );

      expect(moduleNamespace.result).toBe("external-subpath");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("resolves configured dependency subpaths from the importing package", async () => {
    const app = await scenarioApp({
      files: {
        "agent/channels/api/contact-sales/webhook.ts": [
          'import { readExternalValue } from "@repo/enrichment/external-value";',
          "",
          "export const result = readExternalValue();",
          "",
        ].join("\n"),
      },
      name: "workspace-package-nested-external-subpath",
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-workspace-nested-external-subpath-"));

    try {
      const packageRoot = join(workspaceRoot, "packages", "enrichment");
      const externalPackageRoot = join(packageRoot, "node_modules", "external-only");
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await mkdir(join(externalPackageRoot, "ext"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            exports: {
              "./external-value": "./src/external-value.ts",
            },
            name: "@repo/enrichment",
            type: "module",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageRoot, "src", "external-value.ts"),
        [
          'import externalTags from "external-only/ext/tags";',
          "",
          "export function readExternalValue() {",
          "  return externalTags.value;",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(externalPackageRoot, "package.json"),
        JSON.stringify({ main: "index.js", name: "external-only", type: "commonjs" }, null, 2),
      );
      await writeFile(
        join(externalPackageRoot, "ext", "tags.js"),
        "module.exports = { value: 'nested-external-subpath' };\n",
      );

      await mkdir(join(app.appRoot, "node_modules", "@repo"), { recursive: true });
      await symlink(
        packageRoot,
        join(app.appRoot, "node_modules", "@repo", "enrichment"),
        "junction",
      );

      const moduleNamespace = await loadAuthoredModuleNamespace(
        join(app.appRoot, "agent", "channels", "api", "contact-sales", "webhook.ts"),
        { externalDependencies: ["external-only"] },
      );

      expect(moduleNamespace.result).toBe("nested-external-subpath");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("applies agent build externals while compiling authored modules", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts": [
          "export default {",
          '  model: "anthropic/claude-sonnet-5",',
          '  build: { externalDependencies: ["external-only"] },',
          "};",
          "",
        ].join("\n"),
        "agent/tools/read_external.ts": [
          'import { readExternalValue } from "@repo/enrichment/external-value";',
          "",
          "export default {",
          '  description: "Read the external package value.",',
          "  execute() {",
          "    return readExternalValue();",
          "  },",
          "};",
          "",
        ].join("\n"),
      },
      name: "compile-agent-configured-external",
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-compile-configured-external-"));

    try {
      const packageRoot = join(workspaceRoot, "packages", "enrichment");
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            exports: {
              "./external-value": "./src/external-value.ts",
            },
            name: "@repo/enrichment",
            type: "module",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageRoot, "src", "external-value.ts"),
        [
          'import externalOnly from "external-only";',
          "",
          "export function readExternalValue() {",
          "  return externalOnly.value;",
          "}",
          "",
        ].join("\n"),
      );

      const externalPackageRoot = join(app.appRoot, "node_modules", "external-only");
      await mkdir(externalPackageRoot, { recursive: true });
      await writeFile(
        join(externalPackageRoot, "package.json"),
        JSON.stringify({ main: "index.cjs", name: "external-only" }, null, 2),
      );
      await writeFile(
        join(externalPackageRoot, "index.cjs"),
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          "module.exports = {",
          '  value: fs.readFileSync(path.join(__dirname, "payload.txt"), "utf8").trim(),',
          "};",
          "",
        ].join("\n"),
      );
      await writeFile(join(externalPackageRoot, "payload.txt"), "compiled-external\n");

      await mkdir(join(app.appRoot, "node_modules", "@repo"), { recursive: true });
      await symlink(
        packageRoot,
        join(app.appRoot, "node_modules", "@repo", "enrichment"),
        "junction",
      );

      const discovered = await discoverAgent({
        agentRoot: join(app.appRoot, "agent"),
        appRoot: app.appRoot,
      });
      const manifest = await compileAgentManifest(discovered.manifest);

      expect(manifest.config.build?.externalDependencies).toEqual(["external-only"]);
      expect(manifest.tools).toHaveLength(1);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("inherits root build externals while compiling subagent authored modules", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts": [
          "export default {",
          '  model: "anthropic/claude-sonnet-5",',
          '  build: { externalDependencies: ["external-only"] },',
          "};",
          "",
        ].join("\n"),
        "agent/subagents/signal-gatherer/agent.ts": [
          "export default {",
          '  description: "Gather abuse signals.",',
          '  model: "anthropic/claude-sonnet-5",',
          "};",
          "",
        ].join("\n"),
        "agent/subagents/signal-gatherer/tools/read_external.ts": [
          'import { readExternalValue } from "@repo/enrichment/external-value";',
          "",
          "export default {",
          '  description: "Read the external package value.",',
          "  execute() {",
          "    return readExternalValue();",
          "  },",
          "};",
          "",
        ].join("\n"),
      },
      name: "compile-subagent-inherited-external",
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-subagent-inherited-external-"));

    try {
      const packageRoot = join(workspaceRoot, "packages", "enrichment");
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify(
          {
            exports: {
              "./external-value": "./src/external-value.ts",
            },
            name: "@repo/enrichment",
            type: "module",
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(packageRoot, "src", "external-value.ts"),
        [
          'import externalOnly from "external-only";',
          "",
          "export function readExternalValue() {",
          "  return externalOnly.value;",
          "}",
          "",
        ].join("\n"),
      );

      const externalPackageRoot = join(app.appRoot, "node_modules", "external-only");
      await mkdir(externalPackageRoot, { recursive: true });
      await writeFile(
        join(externalPackageRoot, "package.json"),
        JSON.stringify({ main: "index.cjs", name: "external-only" }, null, 2),
      );
      await writeFile(
        join(externalPackageRoot, "index.cjs"),
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          "module.exports = {",
          '  value: fs.readFileSync(path.join(__dirname, "payload.txt"), "utf8").trim(),',
          "};",
          "",
        ].join("\n"),
      );
      await writeFile(join(externalPackageRoot, "payload.txt"), "subagent-external\n");

      await mkdir(join(app.appRoot, "node_modules", "@repo"), { recursive: true });
      await symlink(
        packageRoot,
        join(app.appRoot, "node_modules", "@repo", "enrichment"),
        "junction",
      );

      const discovered = await discoverAgent({
        agentRoot: join(app.appRoot, "agent"),
        appRoot: app.appRoot,
      });
      const manifest = await compileAgentManifest(discovered.manifest);

      expect(manifest.config.build?.externalDependencies).toEqual(["external-only"]);
      expect(manifest.subagents[0]?.agent.config.build?.externalDependencies).toEqual([
        "external-only",
      ]);
      expect(manifest.subagents[0]?.agent.tools).toHaveLength(1);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("loads authored modules that use asset imports", async () => {
    const app = await scenarioApp({
      files: {
        "agent/assets/logo.bin": "logo-bytes",
        "agent/assets/logo.png": "png-bytes",
        "agent/assets/message.txt": "asset text",
        "agent/tools/use_assets.ts": [
          'import logoUrl from "../assets/logo.bin";',
          'import imageUrl from "../assets/logo.png";',
          'import rawText from "../assets/message.txt?raw";',
          "",
          "export default {",
          '  description: "Use asset imports.",',
          "  async execute() {",
          "    return {",
          "      imageUrl,",
          "      logoUrl,",
          "      rawText,",
          "    };",
          "  },",
          "};",
          "",
        ].join("\n"),
      },
      name: "dynamic-and-asset-imports",
    });

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(app.appRoot, "agent", "tools", "use_assets.ts"),
    );
    const tool = moduleNamespace.default as {
      execute(): Promise<{
        imageUrl: string;
        logoUrl: string;
        rawText: string;
      }>;
    };

    await expect(tool.execute()).resolves.toEqual({
      imageUrl: "data:image/png;base64,cG5nLWJ5dGVz",
      logoUrl: "data:application/octet-stream;base64,bG9nby1ieXRlcw==",
      rawText: "asset text",
    });
  });

  it("recovers in the same process once a missing package is installed", async () => {
    // Regression: bundling used to emit unresolvable package imports as
    // bare externals, so the loader handed Node an import that could not
    // resolve. That first failed import poisons Node's process-wide
    // package-config cache with a negative entry for the package path;
    // after installing the package (pnpm-style symlink, subpath export),
    // the same process kept failing with the no-exports fallback error
    // ("Cannot find module .../node_modules/@scope/pkg/sub") until restart.
    // Failing at bundle time instead keeps the process recoverable.
    const app = await scenarioApp({
      files: {
        "agent/channels/api/late-install/webhook.ts": [
          'import { value } from "@scope/late-dep/sub";',
          "",
          "export const result = value;",
          "",
        ].join("\n"),
      },
      name: "late-installed-package",
    });
    const modulePath = join(app.appRoot, "agent", "channels", "api", "late-install", "webhook.ts");

    await expect(loadAuthoredModuleNamespace(modulePath)).rejects.toThrow(
      /Cannot resolve package "@scope\/late-dep\/sub"/,
    );

    const storeRoot = join(
      app.appRoot,
      "node_modules",
      ".pnpm",
      "@scope+late-dep@1.0.0",
      "node_modules",
      "@scope",
      "late-dep",
    );
    await mkdir(storeRoot, { recursive: true });
    await writeFile(
      join(storeRoot, "package.json"),
      JSON.stringify(
        { exports: { "./sub": "./sub.js" }, name: "@scope/late-dep", type: "module" },
        null,
        2,
      ),
    );
    await writeFile(join(storeRoot, "sub.js"), 'export const value = "installed";\n');
    await mkdir(join(app.appRoot, "node_modules", "@scope"), { recursive: true });
    await symlink(storeRoot, join(app.appRoot, "node_modules", "@scope", "late-dep"), "junction");

    const moduleNamespace = await loadAuthoredModuleNamespace(modulePath);

    expect(moduleNamespace.result).toBe("installed");
  });

  it("adds actionable hints when authored bundling hits native module imports", async () => {
    const app = await scenarioApp({
      files: {
        "agent/native.node": "not really native",
        "agent/tools/use_native.ts": [
          'import nativeModule from "../native.node";',
          "",
          "export const result = nativeModule;",
          "",
        ].join("\n"),
      },
      name: "native-module-hint",
    });

    await expect(
      loadAuthoredModuleNamespace(join(app.appRoot, "agent", "tools", "use_native.ts")),
    ).rejects.toThrow(/build\.externalDependencies|asset import/);
  });
});
