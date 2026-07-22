import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import {
  copyNitroFunctionDirectory,
  emitBundledWorkflowFunctionDirectory,
  retargetNitroFunctionDirectoryToWorkflowRoute,
} from "#internal/workflow-bundle/vercel-workflow-output.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__workflowStandalonePluginLoaded;
  delete (globalThis as Record<string, unknown>).__workflowStandaloneImportMetaPluginLoaded;
  delete (globalThis as Record<string, unknown>).__workflowStandaloneCommonJsPluginLoaded;

  await Promise.all(
    temporaryDirectories.splice(0).map((directoryPath) =>
      rm(directoryPath, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("copyNitroFunctionDirectory", () => {
  it("prefers the route-specific Nitro function directory when it exists", async () => {
    const root = await mkdtemp(join(resolvePackageRoot(), ".eve-vercel-workflow-copy-source-"));
    temporaryDirectories.push(root);

    const sourcePath = join(root, "functions", ".well-known", "workflow", "v1", "step.func");
    const fallbackPath = join(root, "functions", "__server.func");
    const targetPath = join(root, "staged", "step.func");

    await Promise.all([
      mkdir(sourcePath, { recursive: true }),
      mkdir(fallbackPath, { recursive: true }),
      mkdir(targetPath, { recursive: true }),
    ]);

    await Promise.all([
      writeFile(join(sourcePath, "index.mjs"), 'export const marker = "route-source";\n'),
      writeFile(join(fallbackPath, "index.mjs"), 'export const marker = "server-fallback";\n'),
      writeFile(join(targetPath, "stale.txt"), "remove-me\n"),
    ]);

    await copyNitroFunctionDirectory({
      fallbackPath,
      sourcePath,
      targetPath,
    });

    await expect(readFile(join(targetPath, "index.mjs"), "utf8")).resolves.toContain(
      "route-source",
    );
    await expect(readFile(join(targetPath, "stale.txt"), "utf8")).rejects.toThrow();
  });

  it("falls back to Nitro's __server function when the route path is missing", async () => {
    const root = await mkdtemp(join(resolvePackageRoot(), ".eve-vercel-workflow-copy-fallback-"));
    temporaryDirectories.push(root);

    const sourcePath = join(root, "functions", ".well-known", "workflow", "v1", "step.func");
    const fallbackPath = join(root, "functions", "__server.func");
    const targetPath = join(root, "staged", "step.func");

    await mkdir(fallbackPath, { recursive: true });
    await writeFile(join(fallbackPath, "index.mjs"), 'export const marker = "server-fallback";\n');

    await copyNitroFunctionDirectory({
      fallbackPath,
      sourcePath,
      targetPath,
    });

    await expect(readFile(join(targetPath, "index.mjs"), "utf8")).resolves.toContain(
      "server-fallback",
    );
  });

  it("materializes traced node_modules symlinks into concrete files", async () => {
    const root = await mkdtemp(join(resolvePackageRoot(), ".eve-vercel-workflow-copy-linked-"));
    temporaryDirectories.push(root);

    const sourcePath = join(root, "functions", ".well-known", "workflow", "v1", "step.func");
    const fallbackPath = join(root, "functions", "__server.func");
    const targetPath = join(root, "staged", "step.func");
    const tracedPackagePath = join(fallbackPath, "node_modules", ".nf3", "rolldown@1.0.0-rc.18");
    const linkedPackagePath = join(sourcePath, "node_modules", "rolldown");

    await Promise.all([
      mkdir(sourcePath, { recursive: true }),
      mkdir(join(sourcePath, "node_modules"), { recursive: true }),
      mkdir(tracedPackagePath, { recursive: true }),
    ]);
    await writeFile(join(tracedPackagePath, "package.json"), '{ "name": "rolldown" }\n');
    await symlink(tracedPackagePath, linkedPackagePath);

    await copyNitroFunctionDirectory({
      fallbackPath,
      sourcePath,
      targetPath,
    });

    const copiedPackagePath = join(targetPath, "node_modules", "rolldown");
    await expect(readFile(join(copiedPackagePath, "package.json"), "utf8")).resolves.toContain(
      '"name": "rolldown"',
    );
    const copiedStats = await lstat(copiedPackagePath);
    expect(copiedStats.isSymbolicLink()).toBe(false);
  });
});

describe("retargetNitroFunctionDirectoryToWorkflowRoute", () => {
  it("rewrites the configured handler to target one workflow route", async () => {
    const root = await mkdtemp(join(resolvePackageRoot(), ".eve-vercel-workflow-retarget-"));
    temporaryDirectories.push(root);

    const functionDirectoryPath = join(
      root,
      "functions",
      ".well-known",
      "workflow",
      "v1",
      "step.func",
    );

    await mkdir(functionDirectoryPath, { recursive: true });
    await Promise.all([
      writeFile(join(functionDirectoryPath, "index.js"), 'export const marker = "nitro";\n'),
      writeFile(
        join(functionDirectoryPath, ".vc-config.json"),
        `${JSON.stringify(
          {
            handler: "index.js",
            launcherType: "Nodejs",
          },
          null,
          2,
        )}\n`,
      ),
    ]);

    await retargetNitroFunctionDirectoryToWorkflowRoute({
      functionDirectoryPath,
      workflowRoutePath: "/.well-known/workflow/v1/step",
    });

    await expect(readFile(join(functionDirectoryPath, "index.js"), "utf8")).resolves.toContain(
      "/.well-known/workflow/v1/step",
    );
    await expect(
      readFile(join(functionDirectoryPath, "__eve_nitro_handler__.js"), "utf8"),
    ).resolves.toContain('marker = "nitro"');
  });

  it("uses index.mjs when .vc-config.json has no handler", async () => {
    const root = await mkdtemp(
      join(resolvePackageRoot(), ".eve-vercel-workflow-retarget-fallback-"),
    );
    temporaryDirectories.push(root);

    const functionDirectoryPath = join(
      root,
      "functions",
      ".well-known",
      "workflow",
      "v1",
      "flow.func",
    );

    await mkdir(functionDirectoryPath, { recursive: true });
    await writeFile(join(functionDirectoryPath, "index.mjs"), "export default { fetch() {} };\n");

    await retargetNitroFunctionDirectoryToWorkflowRoute({
      functionDirectoryPath,
      workflowRoutePath: "/.well-known/workflow/v1/flow",
    });

    await expect(readFile(join(functionDirectoryPath, "index.mjs"), "utf8")).resolves.toContain(
      "/.well-known/workflow/v1/flow",
    );
    await expect(
      readFile(join(functionDirectoryPath, "__eve_nitro_handler__.mjs"), "utf8"),
    ).resolves.toContain("export default");
  });
});

describe("emitBundledWorkflowFunctionDirectory", () => {
  it("bundles one standalone flow handler without Nitro's authored-module loader", async () => {
    const root = await mkdtemp(join(resolvePackageRoot(), ".eve-vercel-workflow-standalone-"));
    temporaryDirectories.push(root);

    const bundlePath = join(root, "workflow-build", "workflows.mjs");
    const targetPath = join(root, "functions", ".well-known", "workflow", "v1", "flow.func");

    await mkdir(join(root, "workflow-build"), { recursive: true });
    await writeFile(
      bundlePath,
      [
        "const workflowCode = `standalone-flow-marker",
        "//# sourceMappingURL=data:application/json;base64,ZmFrZQ==",
        "`;",
        'export const POST = async (req) => new Response(workflowCode + ":" + req.url);',
        "",
      ].join("\n"),
    );

    await emitBundledWorkflowFunctionDirectory({
      bundlePath,
      targetPath,
    });

    const require = createRequire(import.meta.url);
    const emittedHandler = require(join(targetPath, "index.js")) as (
      request:
        | {
            headers?: Record<string, string>;
            method?: string;
            url: string;
          }
        | {
            req: {
              headers?: Record<string, string>;
              method?: string;
              url: string;
            };
          },
    ) => Promise<Response>;
    const directRequestResponse = await emittedHandler({
      url: "https://example.com/.well-known/workflow/v1/flow",
    });
    const wrappedRequestResponse = await emittedHandler({
      req: {
        url: "https://example.com/.well-known/workflow/v1/flow?wrapped=1",
      },
    });
    const relativeRequestResponse = await emittedHandler({
      headers: {
        host: "example.com",
        "x-forwarded-proto": "https",
      },
      method: "POST",
      url: "/.well-known/workflow/v1/flow?relative=1",
    });

    await expect(readFile(join(targetPath, "index.js"), "utf8")).resolves.toContain(
      "standalone-flow-marker",
    );
    await expect(readFile(join(targetPath, "index.js"), "utf8")).resolves.not.toContain(
      "loadAuthoredModuleNamespace",
    );
    await expect(readFile(join(targetPath, "index.js"), "utf8")).resolves.toContain(
      "sourceMappingURL=data:application/json;base64,ZmFrZQ==",
    );
    await expect(directRequestResponse.text()).resolves.toContain(
      ":https://example.com/.well-known/workflow/v1/flow",
    );
    await expect(wrappedRequestResponse.text()).resolves.toContain(
      ":https://example.com/.well-known/workflow/v1/flow?wrapped=1",
    );
    await expect(relativeRequestResponse.text()).resolves.toContain(
      ":https://example.com/.well-known/workflow/v1/flow?relative=1",
    );
    await expect(readFile(join(targetPath, "package.json"), "utf8")).resolves.toContain(
      '"type": "commonjs"',
    );
    const config = JSON.parse(await readFile(join(targetPath, ".vc-config.json"), "utf8")) as {
      environment?: Record<string, unknown>;
      handler?: unknown;
      supportsResponseStreaming?: unknown;
    };
    expect(config.handler).toBe("index.js");
    expect(config.supportsResponseStreaming).toBe(true);
    expect(config.environment).toEqual({
      NODE_OPTIONS: "--experimental-require-module",
      WORKFLOW_PRECONDITION_GUARD: "1",
    });
  });

  it("bundles optional plugin imports into the standalone workflow handler", async () => {
    const root = await mkdtemp(join(resolvePackageRoot(), ".eve-vercel-workflow-standalone-"));
    temporaryDirectories.push(root);

    const bundlePath = join(root, "workflow-build", "workflows.mjs");
    const pluginPath = join(root, "workflow-build", "plugin.mjs");
    const targetPath = join(root, "functions", ".well-known", "workflow", "v1", "flow.func");

    await mkdir(join(root, "workflow-build"), { recursive: true });
    await Promise.all([
      writeFile(
        bundlePath,
        [
          'export const POST = async () => new Response(String(globalThis.__workflowStandalonePluginLoaded ?? "missing"));',
          "",
        ].join("\n"),
      ),
      writeFile(
        pluginPath,
        ['(globalThis).__workflowStandalonePluginLoaded = "yes";', ""].join("\n"),
      ),
    ]);

    await emitBundledWorkflowFunctionDirectory({
      bundlePath,
      pluginPaths: [pluginPath],
      targetPath,
    });

    const require = createRequire(import.meta.url);
    const emittedHandler = require(join(targetPath, "index.js")) as (request: {
      url: string;
    }) => Promise<Response>;
    const response = await emittedHandler({
      url: "https://example.com/.well-known/workflow/v1/flow",
    });

    expect((globalThis as Record<string, unknown>).__workflowStandalonePluginLoaded).toBe("yes");
    await expect(response.text()).resolves.toBe("yes");
  });

  it("loads plugin modules as ESM so import.meta.url remains available", async () => {
    const root = await mkdtemp(join(resolvePackageRoot(), ".eve-vercel-workflow-standalone-"));
    temporaryDirectories.push(root);

    const bundlePath = join(root, "workflow-build", "workflows.mjs");
    const pluginPath = join(root, "workflow-build", "plugin.mjs");
    const targetPath = join(root, "functions", ".well-known", "workflow", "v1", "flow.func");

    await mkdir(join(root, "workflow-build"), { recursive: true });
    await Promise.all([
      writeFile(
        bundlePath,
        [
          'export const POST = async () => new Response(String(globalThis.__workflowStandaloneImportMetaPluginLoaded ?? "missing"));',
          "",
        ].join("\n"),
      ),
      writeFile(
        pluginPath,
        [
          'import { createRequire } from "node:module";',
          "const require = createRequire(import.meta.url);",
          '(globalThis).__workflowStandaloneImportMetaPluginLoaded = require("node:path").sep;',
          "",
        ].join("\n"),
      ),
    ]);

    await emitBundledWorkflowFunctionDirectory({
      bundlePath,
      pluginPaths: [pluginPath],
      targetPath,
    });

    const require = createRequire(import.meta.url);
    const emittedHandler = require(join(targetPath, "index.js")) as (request: {
      url: string;
    }) => Promise<Response>;
    const response = await emittedHandler({
      url: "https://example.com/.well-known/workflow/v1/flow",
    });

    await expect(
      readFile(join(targetPath, "__eve_workflow_plugin_0.mjs"), "utf8"),
    ).resolves.toBeTruthy();
    expect((globalThis as Record<string, unknown>).__workflowStandaloneImportMetaPluginLoaded).toBe(
      "/",
    );
    await expect(response.text()).resolves.toBe("/");
  });

  it("supports bundled CommonJS plugin dependencies that require Node builtins", async () => {
    const root = await mkdtemp(join(resolvePackageRoot(), ".eve-vercel-workflow-standalone-"));
    temporaryDirectories.push(root);

    const bundlePath = join(root, "workflow-build", "workflows.mjs");
    const pluginPath = join(root, "workflow-build", "plugin.mjs");
    const commonJsDependencyPath = join(root, "workflow-build", "builtin-loader.cjs");
    const targetPath = join(root, "functions", ".well-known", "workflow", "v1", "flow.func");

    await mkdir(join(root, "workflow-build"), { recursive: true });
    await Promise.all([
      writeFile(
        bundlePath,
        [
          'export const POST = async () => new Response(String(globalThis.__workflowStandaloneCommonJsPluginLoaded ?? "missing"));',
          "",
        ].join("\n"),
      ),
      writeFile(
        commonJsDependencyPath,
        ['const fs = require("node:fs");', "module.exports = typeof fs.readFile;", ""].join("\n"),
      ),
      writeFile(
        pluginPath,
        [
          'import builtinLoader from "./builtin-loader.cjs";',
          "(globalThis).__workflowStandaloneCommonJsPluginLoaded = builtinLoader;",
          "",
        ].join("\n"),
      ),
    ]);

    await emitBundledWorkflowFunctionDirectory({
      bundlePath,
      pluginPaths: [pluginPath],
      targetPath,
    });

    const require = createRequire(import.meta.url);
    const emittedHandler = require(join(targetPath, "index.js")) as (request: {
      url: string;
    }) => Promise<Response>;
    const response = await emittedHandler({
      url: "https://example.com/.well-known/workflow/v1/flow",
    });

    expect((globalThis as Record<string, unknown>).__workflowStandaloneCommonJsPluginLoaded).toBe(
      "function",
    );
    await expect(response.text()).resolves.toBe("function");
  });
});
