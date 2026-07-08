import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const EVE_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMPILED_VENDOR_ROOT = join(EVE_PACKAGE_ROOT, ".generated", "compiled");
const VENDOR_WARNING_LOG_PATH = join(EVE_PACKAGE_ROOT, "scripts", "vendor-warning-log.mjs");
const require = createRequire(import.meta.url);
const VERCEL_SANDBOX_DIST_ROOT = join(
  dirname(require.resolve("@vercel/sandbox/package.json")),
  "dist",
);

type VendorWarningLog = {
  readonly createVendoredDependencyWarningFilter: () => {
    readonly onLog: (
      level: string,
      log: {
        readonly id?: string;
        readonly loc?: { readonly file?: string };
        readonly message: string;
      },
      defaultHandler: (level: string, log: { readonly message: string }) => void,
    ) => void;
  };
};

async function loadVendorWarningLog(): Promise<VendorWarningLog> {
  return (await import(pathToFileURL(VENDOR_WARNING_LOG_PATH).href)) as VendorWarningLog;
}

function containsSourceMapComment(source: string): boolean {
  return /(?:^|\n)\s*\/\/# sourceMappingURL=/u.test(source);
}

function rewriteDeclarationImports(
  source: string,
  rewrites: Readonly<Record<string, string>>,
): string {
  let rewritten = source;
  for (const [moduleName, replacement] of Object.entries(rewrites)) {
    rewritten = rewritten
      .replaceAll(`from '${moduleName}'`, `from '${replacement}'`)
      .replaceAll(`from "${moduleName}"`, `from "${replacement}"`)
      .replaceAll(`import '${moduleName}'`, `import '${replacement}'`)
      .replaceAll(`import "${moduleName}"`, `import "${replacement}"`);
  }
  return rewritten;
}

describe("compiled vendor assets", () => {
  it("does not generate source maps for vendored packages", async () => {
    const entries = await readdir(COMPILED_VENDOR_ROOT, {
      recursive: true,
    });
    const sourceMapFiles = entries.filter((entry) => entry.endsWith(".map"));
    const javaScriptFiles = entries.filter((entry) => entry.endsWith(".js"));
    const javaScriptSources = await Promise.all(
      javaScriptFiles.map((entry) => readFile(join(COMPILED_VENDOR_ROOT, entry), "utf8")),
    );

    expect(sourceMapFiles).toEqual([]);
    expect(javaScriptSources.some(containsSourceMapComment)).toBe(false);
  });

  it("suppresses dependency warnings without hiding actionable logs", async () => {
    const { createVendoredDependencyWarningFilter } = await loadVendorWarningLog();
    const forwardedLogs: string[] = [];
    const filter = createVendoredDependencyWarningFilter();
    const dependencyFilePath = join(
      EVE_PACKAGE_ROOT,
      "..",
      "..",
      "node_modules",
      "fixture",
      "index.js",
    );
    const generatedCompiledFilePath = join(
      EVE_PACKAGE_ROOT,
      ".generated",
      "compiled",
      "gray-matter",
      "index.js",
    );
    const distCompiledFilePath = join(
      EVE_PACKAGE_ROOT,
      "dist",
      "src",
      "compiled",
      "gray-matter",
      "index.js",
    );
    const scriptFilePath = join(EVE_PACKAGE_ROOT, "scripts", "vendor-compiled.mjs");

    filter.onLog(
      "warn",
      {
        loc: {
          file: dependencyFilePath,
        },
        message: "dependency implementation detail",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );
    filter.onLog(
      "warn",
      {
        id: generatedCompiledFilePath,
        message: "generated compiled dependency implementation detail",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );
    filter.onLog(
      "warn",
      {
        loc: {
          file: distCompiledFilePath,
        },
        message: "dist compiled dependency implementation detail",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );
    filter.onLog(
      "warn",
      {
        id: scriptFilePath,
        message: "eve vendoring warning",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );
    filter.onLog(
      "error",
      {
        loc: {
          file: dependencyFilePath,
        },
        message: "dependency build failure",
      },
      (level, log) => {
        forwardedLogs.push(`${level}:${log.message}`);
      },
    );

    expect(forwardedLogs).toEqual(["warn:eve vendoring warning", "error:dependency build failure"]);
  });

  it("copies @workflow/core declaration files from the installed package", async () => {
    const [indexDts, createHookDts, workflowDts, workflowIndexDts, runtimeRunDts] =
      await Promise.all([
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/index.d.ts"), "utf8"),
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/create-hook.d.ts"), "utf8"),
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/workflow.d.ts"), "utf8"),
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/workflow/index.d.ts"), "utf8"),
        readFile(join(COMPILED_VENDOR_ROOT, "@workflow/core/runtime/run.d.ts"), "utf8"),
      ]);

    expect(indexDts).toContain("Just the core utilities");
    expect(indexDts).toContain("from '#compiled/@workflow/errors/index.js'");
    expect(createHookDts).toContain("Creates a {@link Hook}");
    expect(workflowDts).toBe(`export * from "./workflow/index.js";\n`);
    expect(workflowIndexDts).toContain("from '#compiled/@workflow/errors/index.js'");
    expect(runtimeRunDts).toContain("from '../_workflow-serde.js'");
  });

  it("vendors the Workflow world targets selected by generated Nitro plugins", async () => {
    const [localWorld, vercelWorld] = await Promise.all([
      readFile(join(COMPILED_VENDOR_ROOT, "@workflow/world-local/index.js"), "utf8"),
      readFile(join(COMPILED_VENDOR_ROOT, "@workflow/world-vercel/index.js"), "utf8"),
    ]);

    expect(localWorld).toContain("createWorld");
    expect(vercelWorld).toContain("createWorld");
  });

  it("copies the complete @vercel/sandbox declaration tree from the installed package", async () => {
    const [upstreamEntries, vendoredEntries] = await Promise.all([
      readdir(VERCEL_SANDBOX_DIST_ROOT, { recursive: true }),
      readdir(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox"), { recursive: true }),
    ]);
    const upstreamDeclarations = upstreamEntries.filter((entry) => entry.endsWith(".d.ts")).sort();
    const generatedStubNames = new Set(["_async-retry.d.ts", "_workflow-serde.d.ts"]);
    const vendoredDeclarations = vendoredEntries
      .filter((entry) => entry.endsWith(".d.ts") && !generatedStubNames.has(entry))
      .sort();

    expect(vendoredDeclarations).toEqual(upstreamDeclarations);

    const [upstreamIndex, vendoredIndex, vendoredSandbox, vendoredBaseClient] = await Promise.all([
      readFile(join(VERCEL_SANDBOX_DIST_ROOT, "index.d.ts"), "utf8"),
      readFile(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox/index.d.ts"), "utf8"),
      readFile(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox/sandbox.d.ts"), "utf8"),
      readFile(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox/api-client/base-client.d.ts"), "utf8"),
    ]);

    expect(vendoredIndex).toBe(upstreamIndex);
    expect(vendoredSandbox).toContain('from "./_workflow-serde.js"');
    expect(vendoredBaseClient).toContain('from "../_async-retry.js"');
    expect(vendoredBaseClient).toContain('import "#compiled/zod/index.js"');
  });

  it("copies AI SDK declarations from the installed packages without authored stubs", async () => {
    const packages = [
      {
        name: "@ai-sdk/anthropic",
        rewrites: {
          "@ai-sdk/provider": "#compiled/@ai-sdk/provider/index.js",
          "@ai-sdk/provider-utils": "#compiled/@ai-sdk/provider-utils/index.js",
          "zod/v4": "#compiled/zod/index.js",
        },
      },
      {
        name: "@ai-sdk/google",
        rewrites: {
          "@ai-sdk/provider": "#compiled/@ai-sdk/provider/index.js",
          "@ai-sdk/provider-utils": "#compiled/@ai-sdk/provider-utils/index.js",
        },
      },
      {
        name: "@ai-sdk/mcp",
        rewrites: {
          "@ai-sdk/provider": "#compiled/@ai-sdk/provider/index.js",
          "@ai-sdk/provider-utils": "#compiled/@ai-sdk/provider-utils/index.js",
          "zod/v4": "#compiled/zod/index.js",
        },
      },
      {
        name: "@ai-sdk/openai",
        rewrites: {
          "@ai-sdk/provider": "#compiled/@ai-sdk/provider/index.js",
          "@ai-sdk/provider-utils": "#compiled/@ai-sdk/provider-utils/index.js",
        },
      },
      {
        name: "@ai-sdk/otel",
        rewrites: {
          "@ai-sdk/provider": "#compiled/@ai-sdk/provider/index.js",
          "@ai-sdk/provider-utils": "#compiled/@ai-sdk/provider-utils/index.js",
          "@opentelemetry/api": "#compiled/@opentelemetry/api/index.js",
        },
      },
      {
        name: "@ai-sdk/provider",
        rewrites: {
          "json-schema": "#compiled/json-schema/index.js",
        },
      },
      {
        name: "@ai-sdk/provider-utils",
        rewrites: {
          "@ai-sdk/provider": "#compiled/@ai-sdk/provider/index.js",
          "@standard-schema/spec": "#compiled/@standard-schema/spec/index.js",
          "@workflow/serde": "#compiled/@workflow/serde/index.js",
          "eventsource-parser/stream": "#compiled/eventsource-parser/stream/index.js",
          "zod/v3": "#compiled/zod/index.js",
          "zod/v4": "#compiled/zod/index.js",
        },
      },
    ] as const;

    for (const packageDefinition of packages) {
      const upstreamRoot = dirname(require.resolve(`${packageDefinition.name}/package.json`));
      const [upstream, vendored] = await Promise.all([
        readFile(join(upstreamRoot, "dist/index.d.ts"), "utf8"),
        readFile(join(COMPILED_VENDOR_ROOT, packageDefinition.name, "index.d.ts"), "utf8"),
      ]);

      expect(vendored).toBe(rewriteDeclarationImports(upstream, packageDefinition.rewrites));
    }
  });

  it("copies AI SDK declaration dependencies from their installed packages", async () => {
    const jsonSchemaRoot = dirname(require.resolve("@types/json-schema/package.json"));
    const serdeRoot = dirname(dirname(require.resolve("@workflow/serde")));
    const eventSourceParserRoot = dirname(require.resolve("eventsource-parser/package.json"));
    const comparisons = [
      [join(jsonSchemaRoot, "index.d.ts"), join(COMPILED_VENDOR_ROOT, "json-schema/index.d.ts")],
      [
        join(serdeRoot, "dist/index.d.ts"),
        join(COMPILED_VENDOR_ROOT, "@workflow/serde/index.d.ts"),
      ],
      [
        join(eventSourceParserRoot, "dist/stream.d.ts"),
        join(COMPILED_VENDOR_ROOT, "eventsource-parser/stream/index.d.ts"),
      ],
    ] as const;

    for (const [upstreamPath, vendoredPath] of comparisons) {
      const [upstream, vendored] = await Promise.all([
        readFile(upstreamPath, "utf8"),
        readFile(vendoredPath, "utf8"),
      ]);
      expect(vendored).toBe(upstream);
    }
  });
});
