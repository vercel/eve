import { relative } from "node:path";

import {
  buildOpaqueTypesStub,
  buildUniqueSymbolStub,
  collectFilesRecursively,
  createDeclarationCopier,
} from "../_shared.mjs";

async function discoverDeclarationFiles({ distDir }) {
  const files = await collectFilesRecursively(distDir, [".d.ts"]);
  return (
    files
      .map((file) => relative(distDir, file).replaceAll("\\", "/"))
      // eve flattens dist/workflow/index.js to workflow.js, so workflow.d.ts
      // is owned by the shim entry below instead of upstream's VM-runner file.
      .filter((file) => file !== "workflow.d.ts")
      .sort()
      .map((file) => ({ source: file, output: file }))
  );
}

function buildMsStub(names, moduleName) {
  const lines = [
    `// Auto-generated stub for \`${moduleName}\` types referenced by a vendored .d.ts.`,
    `// Emitted by scripts/vendor-compiled/@workflow/core.mjs.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    if (name === "StringValue") {
      lines.push(`export type StringValue = string;`);
    } else {
      lines.push(`export type ${name} = unknown;`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildWorkflowUtilsStub(names, moduleName) {
  const lines = [
    `// Auto-generated stub for \`${moduleName}\` types referenced by a vendored .d.ts.`,
    `// Emitted by scripts/vendor-compiled/@workflow/core.mjs.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    if (name === "PromiseWithResolvers") {
      lines.push(
        `export interface PromiseWithResolvers<T = unknown> {`,
        `  promise: Promise<T>;`,
        `  resolve(value: T | PromiseLike<T>): void;`,
        `  reject(reason?: unknown): void;`,
        `}`,
      );
    } else {
      lines.push(`export type ${name} = unknown;`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const copyDeclarations = createDeclarationCopier({
  files: discoverDeclarationFiles,
  rewrites: {
    "@opentelemetry/api": {
      kind: "vendored",
      compiledPath: "@opentelemetry/api",
    },
    "@standard-schema/spec": {
      kind: "vendored",
      compiledPath: "@standard-schema/spec",
    },
    "@workflow/errors": {
      kind: "vendored",
      compiledPath: "@workflow/errors",
    },
    "@workflow/serde": {
      kind: "stub",
      stubBaseName: "_workflow-serde",
      build: buildUniqueSymbolStub,
    },
    "@workflow/utils": {
      kind: "stub",
      stubBaseName: "_workflow-utils",
      build: buildWorkflowUtilsStub,
    },
    "@workflow/world": {
      kind: "vendored",
      compiledPath: "@workflow/world",
    },
    "@workflow/world/attributes-validation": {
      kind: "vendored",
      compiledPath: "@workflow/world",
    },
    devalue: {
      kind: "stub",
      stubBaseName: "_devalue",
      build: buildOpaqueTypesStub,
    },
    ms: {
      kind: "stub",
      stubBaseName: "_ms",
      build: buildMsStub,
    },
    zod: {
      kind: "vendored",
      compiledPath: "zod",
    },
    "quickjs-wasi": {
      kind: "stub",
      stubBaseName: "_quickjs-wasi",
      build: buildOpaqueTypesStub,
    },
  },
});

// @workflow/core@5.0.0-beta.38 restored runtime world selection: its
// `createWorld()` statically imports both first-party world packages. eve
// never calls that factory — worlds are selected and wired explicitly at
// build time — so those imports would only drag the local world into hosted
// Vercel output (and the Vercel world into local-only builds). Stub them
// inside core; each world package keeps its own vendored entry.
const CORE_WORLD_FACTORY_STUB_ID = "\0eve-core-world-factory-stub";

function stubCoreWorldFactories() {
  return {
    name: "eve:stub-core-world-factories",
    resolveId(source, importer) {
      if (source !== "@workflow/world-local" && source !== "@workflow/world-vercel") return null;
      if (typeof importer !== "string") return null;
      if (!importer.replaceAll("\\", "/").includes("/@workflow/core/")) return null;
      return CORE_WORLD_FACTORY_STUB_ID;
    },
    load(id) {
      if (id !== CORE_WORLD_FACTORY_STUB_ID) return null;
      return [
        "export function createWorld() {",
        '  throw new Error("Unsupported in eve: @workflow/core createWorld(). ' +
          'eve selects and wires the workflow world explicitly at build time.");',
        "}",
        "",
      ].join("\n");
    },
  };
}

// @workflow/core@5.0.0-beta.40 lazy-loads the optional QuickJS runtime, but
// Rolldown still emits it as a reachable chunk and Nitro packages that chunk
// into every eve function. eve only supports the Node.js workflow VM, so keep
// the lazy boundary while replacing its target with a small, explicit error.
const CORE_QUICKJS_ENTRYPOINT_STUB_ID = "\0eve-core-quickjs-entrypoint-stub";

function stubCoreQuickJSEntrypoint() {
  return {
    name: "eve:stub-core-quickjs-entrypoint",
    resolveId(source, importer) {
      if (source !== "./runtime/quickjs-entrypoint.js") return null;
      if (typeof importer !== "string") return null;
      if (!importer.replaceAll("\\", "/").includes("/@workflow/core/")) return null;
      return CORE_QUICKJS_ENTRYPOINT_STUB_ID;
    },
    load(id) {
      if (id !== CORE_QUICKJS_ENTRYPOINT_STUB_ID) return null;
      return [
        "export async function runWorkflowWithQuickJS() {",
        '  throw new Error("Unsupported in eve: QuickJS workflow VM. ' +
          'eve uses the Node.js workflow VM.");',
        "}",
        "",
      ].join("\n");
    },
  };
}

function honorReservedRunId() {
  return {
    name: "eve:reserved-run-id",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@workflow/core/dist/runtime/start.js")) return null;
      // A reserved id is the caller's claim on one run. Its `run_created` must
      // land before the queue message is published: start() otherwise swallows
      // the 409 of a run that already exists and still queues this caller's
      // input for it. Awaiting first makes the conflict throw with nothing
      // published, as a dynamic start already does.
      const edits = [
        [
          "const runId = `wrun_${world.createRunId",
          "const runId = opts.runId ?? `wrun_${world.createRunId",
        ],
        [
          "const [runCreatedResult, queueResult] = await Promise.allSettled([",
          "if (opts.runId !== undefined) await runCreated;\nconst [runCreatedResult, queueResult] = await Promise.allSettled([",
        ],
      ];
      let code = source;
      for (const [search, replacement] of edits) {
        if (code.split(search).length !== 2)
          throw new Error("Recheck the reserved Workflow run id transform.");
        code = code.replace(search, replacement);
      }
      return { code, map: null };
    },
  };
}

export default {
  packageName: "@workflow/core",
  compiledPath: "@workflow/core",
  chunkGroup: "workflow",
  plugins: [honorReservedRunId(), stubCoreWorldFactories(), stubCoreQuickJSEntrypoint()],
  entries: [
    { entry: "dist/util.js", outputPath: "util" },
    { entry: "dist/serialization.js", outputPath: "serialization" },
    { entry: "dist/runtime/helpers.js", outputPath: "runtime/helpers" },
    {
      outputPath: "index",
    },
    {
      entry: "dist/workflow/index.js",
      outputPath: "workflow",
      declaration: `export * from "./workflow/index.js";\n`,
    },
    {
      input: "@workflow/core/runtime",
      outputPath: "runtime",
    },
    {
      entry: "dist/private.js",
      outputPath: "private",
    },
  ],
  async copyDeclarations(context) {
    const result = await copyDeclarations(context);
    const { readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(context.destinationRoot, "runtime/start.d.ts");
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      source.replace(
        "export interface StartOptionsBase {",
        "export interface StartOptionsBase {\n    /** Caller-reserved durable run identity. */\n    runId?: string;",
      ),
    );
    return result;
  },
};
