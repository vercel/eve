import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const EVE_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMPILED_VENDOR_ROOT = join(EVE_PACKAGE_ROOT, ".generated", "compiled");
const VENDOR_WARNING_LOG_PATH = join(EVE_PACKAGE_ROOT, "scripts", "vendor-warning-log.mjs");
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const VERCEL_SANDBOX_DRIVES_DIST_ROOT = join(
  dirname(require.resolve("@vercel/sandbox-drives/package.json")),
  "dist",
);
const VERCEL_SANDBOX_STABLE_DIST_ROOT = join(
  dirname(require.resolve("@vercel/sandbox/package.json")),
  "dist",
);

type VendorWarningLog = {
  readonly createVendoredDependencyWarningFilter: () => {
    readonly onLog: (
      level: string,
      log: {
        readonly id?: string;
        readonly ids?: readonly string[];
        readonly loc?: { readonly file?: string };
        readonly message: string;
        readonly pluginCode?: string;
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
  it("stamps the Nitro-resolved Rolldown version", async () => {
    const stamp = JSON.parse(
      await readFile(join(COMPILED_VENDOR_ROOT, ".vendor-stamp.json"), "utf8"),
    ) as { toolVersions?: { rolldown?: string } };
    const nitroRequire = createRequire(require.resolve("nitro/package.json"));
    const rolldownPackage = nitroRequire("rolldown/package.json") as { version: string };

    expect(stamp.toolVersions?.rolldown).toBe(rolldownPackage.version);
  });

  it("shares the OpenTelemetry provider registered through @vercel/otel", async () => {
    const apiUrl = pathToFileURL(
      join(COMPILED_VENDOR_ROOT, "@opentelemetry", "api", "index.js"),
    ).href;
    const vercelOtelUrl = pathToFileURL(
      join(COMPILED_VENDOR_ROOT, "@vercel", "otel", "index.js"),
    ).href;
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'import { createRequire } from "node:module";',
        `import { ROOT_CONTEXT, context, trace } from ${JSON.stringify(apiUrl)};`,
        `import { registerOTel } from ${JSON.stringify(vercelOtelUrl)};`,
        "const require = createRequire(import.meta.url);",
        'const authoredApi = require("@opentelemetry/api");',
        "const endedSpans = [];",
        "const spanProcessor = {",
        "  forceFlush: async () => {},",
        "  onEnd: (span) => endedSpans.push(span),",
        "  onStart: () => {},",
        "  shutdown: async () => {},",
        "};",
        'const earlyTracer = trace.getTracer("early");',
        'const before = earlyTracer.startSpan("before").isRecording();',
        "registerOTel({",
        "  autoDetectResources: false,",
        "  instrumentations: [],",
        '  serviceName: "eve-vendored-opentelemetry-test",',
        "  spanProcessors: [spanProcessor],",
        "});",
        'const earlySpan = earlyTracer.startSpan("early-after-registration");',
        'const lateSpan = trace.getTracer("late").startSpan("late-after-registration");',
        "const earlyAfter = earlySpan.isRecording();",
        "const lateAfter = lateSpan.isRecording();",
        "earlySpan.end();",
        "lateSpan.end();",
        'const parent = trace.getTracer("vendored").startSpan("vendored-parent");',
        "await context.with(trace.setSpan(ROOT_CONTEXT, parent), async () => {",
        "  await Promise.resolve();",
        '  authoredApi.trace.getTracer("authored").startSpan("authored-child").end();',
        "});",
        "parent.end();",
        'const child = endedSpans.find((span) => span.name === "authored-child");',
        "process.stdout.write(JSON.stringify({",
        "  before,",
        "  childParentSpanId: child?.parentSpanContext?.spanId,",
        "  childParentTraceId: child?.parentSpanContext?.traceId,",
        "  earlyAfter,",
        "  lateAfter,",
        "  parentSpanId: parent.spanContext().spanId,",
        "  parentTraceId: parent.spanContext().traceId,",
        "}));",
      ].join("\n"),
    ]);

    const result = JSON.parse(stdout) as {
      readonly before: boolean;
      readonly childParentSpanId: string;
      readonly childParentTraceId: string;
      readonly earlyAfter: boolean;
      readonly lateAfter: boolean;
      readonly parentSpanId: string;
      readonly parentTraceId: string;
    };
    expect(result).toMatchObject({ before: false, earlyAfter: true, lateAfter: true });
    expect(result.childParentTraceId).toBe(result.parentTraceId);
    expect(result.childParentSpanId).toBe(result.parentSpanId);
  });

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
      "warn",
      {
        id: scriptFilePath,
        ids: [scriptFilePath, generatedCompiledFilePath],
        message: "mixed eve and dependency warning",
        pluginCode: generatedCompiledFilePath,
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

    expect(forwardedLogs).toEqual([
      "warn:eve vendoring warning",
      "warn:mixed eve and dependency warning",
      "error:dependency build failure",
    ]);
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

  it("copies the complete Drives-capable @vercel/sandbox declaration tree", async () => {
    const [upstreamEntries, vendoredEntries] = await Promise.all([
      readdir(VERCEL_SANDBOX_DRIVES_DIST_ROOT, { recursive: true }),
      readdir(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox"), { recursive: true }),
    ]);
    const upstreamDeclarations = upstreamEntries.filter((entry) => entry.endsWith(".d.ts")).sort();
    const generatedStubNames = new Set(["_async-retry.d.ts", "_workflow-serde.d.ts"]);
    const vendoredDeclarations = vendoredEntries
      .filter((entry) => entry.endsWith(".d.ts") && !generatedStubNames.has(entry))
      .sort();

    expect(vendoredDeclarations).toEqual(upstreamDeclarations);

    const [upstreamIndex, vendoredIndex, vendoredSandbox, vendoredBaseClient] = await Promise.all([
      readFile(join(VERCEL_SANDBOX_DRIVES_DIST_ROOT, "index.d.ts"), "utf8"),
      readFile(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox/index.d.ts"), "utf8"),
      readFile(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox/sandbox.d.ts"), "utf8"),
      readFile(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox/api-client/base-client.d.ts"), "utf8"),
    ]);

    expect(vendoredIndex).toBe(upstreamIndex);
    expect(vendoredSandbox).toContain('from "./_workflow-serde.js"');
    expect(vendoredBaseClient).toContain('from "../_async-retry.js"');
    expect(vendoredBaseClient).toContain('import "#compiled/zod/index.js"');
  });

  it("copies stable @vercel/sandbox declarations without a second runtime bundle", async () => {
    const [upstreamEntries, vendoredEntries] = await Promise.all([
      readdir(VERCEL_SANDBOX_STABLE_DIST_ROOT, { recursive: true }),
      readdir(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox-stable"), { recursive: true }),
    ]);
    const generatedStubNames = new Set(["_async-retry.d.ts", "_workflow-serde.d.ts"]);
    const upstreamDeclarations = upstreamEntries.filter((entry) => entry.endsWith(".d.ts")).sort();
    const vendoredDeclarations = vendoredEntries
      .filter((entry) => entry.endsWith(".d.ts") && !generatedStubNames.has(entry))
      .sort();

    expect(vendoredDeclarations).toEqual(upstreamDeclarations);
    expect(vendoredEntries.filter((entry) => entry.endsWith(".js"))).toEqual(["index.js"]);
    await expect(
      readFile(join(COMPILED_VENDOR_ROOT, "@vercel/sandbox-stable/index.js"), "utf8"),
    ).resolves.toBe("export {};\n");
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
          "zod/v4": "#compiled/zod/index.js",
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
