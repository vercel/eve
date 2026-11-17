import { readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, parse, relative } from "node:path";

import { buildWithRolldown } from "./rolldown.mjs";
import vendoredZod from "./vendor-compiled/zod.mjs";
import { onVendoredDependencyLog } from "../src/internal/bundler/vendored-dependency-log.ts";

const ROLLDOWN_RUNTIME_HELPER_NAMES = [
  "__commonJS",
  "__commonJSMin",
  "__copyProps",
  "__create",
  "__defProp",
  "__esm",
  "__esmMin",
  "__exportAll",
  "__getOwnPropDesc",
  "__getOwnPropNames",
  "__getProtoOf",
  "__hasOwnProp",
  "__name",
  "__reExport",
  "__require",
  "__toBinary",
  "__toBinaryNode",
  "__toCommonJS",
  "__toESM",
];

const ROLLDOWN_RUNTIME_REFERENCE_PATTERN = new RegExp(
  `\\b(?:${ROLLDOWN_RUNTIME_HELPER_NAMES.join("|")})\\b`,
);

const ROLLDOWN_RUNTIME_IMPORT_PATTERN =
  /^import\s*(?:"|')(?:\.{1,2}\/)+_virtual\/_rolldown\/runtime\.js(?:"|');\n?/m;

function createStripUnusedRolldownRuntimeImportPlugin() {
  return {
    name: "eve-strip-unused-rolldown-runtime-import",
    renderChunk(code) {
      const match = code.match(ROLLDOWN_RUNTIME_IMPORT_PATTERN);

      if (match === null) {
        return null;
      }

      const before = code.slice(0, match.index);
      const after = code.slice(match.index + match[0].length);

      if (ROLLDOWN_RUNTIME_REFERENCE_PATTERN.test(`${before}${after}`)) {
        return null;
      }

      return { code: `${before}${after}`, map: null };
    },
  };
}

function createDynamicToolTransformPlugin() {
  let transformFn;
  return {
    name: "eve:dynamic-tool-transform",
    async transform(code, id) {
      if (!id.includes("/framework-tools/")) return null;
      if (!code.includes("defineDynamic")) return null;
      if (!transformFn) {
        const mod = await import("../src/internal/workflow-bundle/dynamic-tool-transform.ts");
        transformFn = mod.transformDynamicToolExecute;
      }
      const result = await transformFn(id, code);
      return result ? { code: result.code, map: null } : null;
    },
  };
}

function createWorkflowMetadataTransformPlugin() {
  let transformPromise;
  return {
    name: "eve:workflow-metadata-transform",
    async transform(code, id) {
      if (!code.includes("use workflow")) return null;
      transformPromise ??= import("../src/internal/workflow-bundle/workflow-builders.ts").then(
        (mod) => mod.applyWorkflowTransform,
      );
      const transformFn = await transformPromise;
      const filename = relative(process.cwd(), id).replaceAll("\\", "/");
      const result = await transformFn(filename, code, "metadata", id, process.cwd());
      return result.code === code ? null : { code: result.code, map: null };
    },
  };
}

const SRC_ROOT = "src";
const OUTPUT_DIR = "dist/src";

const EXCLUDED_FILE_PATTERNS = [
  /\.test\.ts$/,
  /\.integration\.test\.ts$/,
  /\.scenario\.test\.ts$/,
  /\.e2e\.test\.ts$/,
  /\/setup\/build\.ts$/,
  /\/execution\/workflow-host\/step-boundary\.ts$/,
];

const EXCLUDED_DIRECTORIES = new Set([
  join("internal", "testing"),
  join("execution", "in-process"),
]);

const EXTERNAL_PACKAGES = new Set([
  "@nuxt/kit",
  "@sveltejs/kit",
  "ai",
  "braintrust",
  "just-bash",
  "next",
  "nitro",
  "react",
  "rolldown",
  "svelte",
  "undici",
  "vite",
  "vue",
]);

function isExternalPackageSpecifier(source) {
  if (source === "eve" || source.startsWith("eve/")) {
    return true;
  }

  if (source.startsWith("#")) {
    return true;
  }

  if (isBuiltin(source)) {
    return true;
  }

  for (const packageName of EXTERNAL_PACKAGES) {
    if (source === packageName || source.startsWith(`${packageName}/`)) {
      return true;
    }
  }

  return false;
}

const VENDORED_ZOD_IMPORTS = new Map(
  Object.entries(vendoredZod.sharedSpecifiers).map(([specifier, outputPath]) => [
    specifier,
    `#compiled/zod/${outputPath}.js`,
  ]),
);

function createVendoredZodPlugin() {
  return {
    name: "eve:vendored-zod",
    resolveId(source, importer) {
      if (source !== "zod" && !source.startsWith("zod/")) return null;
      const id = VENDORED_ZOD_IMPORTS.get(source);
      if (id === undefined) {
        throw new Error(
          `${importer ?? "eve"} imports "${source}", which eve's vendored Zod does not export. ` +
            `Add it to sharedSpecifiers in scripts/vendor-compiled/zod.mjs.`,
        );
      }
      return { id, external: true };
    },
  };
}

function createVendoredConnectPlugin() {
  return {
    name: "eve:vendored-connect",
    resolveId(source, importer) {
      if (source !== "@vercel/connect" && !source.startsWith("@vercel/connect/")) return null;
      if (source !== "@vercel/connect") {
        throw new Error(
          `${importer ?? "eve"} imports "${source}", but eve vendors only the root ` +
            `"@vercel/connect" entry. See scripts/vendor-compiled/@vercel/connect.mjs.`,
        );
      }
      return { id: "#compiled/@vercel/connect/index.js", external: true };
    },
  };
}

function createVendoredTelemetryPlugin() {
  const packages = new Set([
    "@opentelemetry/api",
    "@opentelemetry/otlp-transformer",
    "@vercel/otel",
  ]);
  return {
    name: "eve:vendored-telemetry",
    resolveId(source) {
      return packages.has(source) ? { id: `#compiled/${source}/index.js`, external: true } : null;
    },
  };
}

async function collectSourceFiles(directory, relativeRoot = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const sourceFiles = [];

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    const relativePath = join(relativeRoot, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(relativePath)) {
        continue;
      }
      sourceFiles.push(...(await collectSourceFiles(fullPath, relativePath)));
      continue;
    }

    if (!entry.isFile() || !fullPath.endsWith(".ts")) {
      continue;
    }

    if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(fullPath))) {
      continue;
    }

    sourceFiles.push(fullPath);
  }

  return sourceFiles;
}

const sourceFiles = await collectSourceFiles(SRC_ROOT);

if (sourceFiles.length === 0) {
  throw new Error(`No TypeScript sources found under ${SRC_ROOT}.`);
}

const input = Object.fromEntries(
  sourceFiles.map((sourcePath) => {
    const relativeFromSrc = relative(SRC_ROOT, sourcePath);
    const parsed = parse(relativeFromSrc);
    const entryName = join(parsed.dir, parsed.name).replaceAll("\\", "/");
    return [entryName, sourcePath];
  }),
);

await buildWithRolldown({
  input,
  external: isExternalPackageSpecifier,
  platform: "node",
  plugins: [
    createVendoredZodPlugin(),
    createVendoredConnectPlugin(),
    createVendoredTelemetryPlugin(),
    createStripUnusedRolldownRuntimeImportPlugin(),
    createDynamicToolTransformPlugin(),
    createWorkflowMetadataTransformPlugin(),
  ],
  resolve: {
    conditionNames: ["eve-source"],
    mainFields: ["module", "main"],
  },
  treeshake: false,
  output: {
    comments: false,
    dir: OUTPUT_DIR,
    entryFileNames: "[name].js",
    format: "esm",
    minify: {
      compress: { joinVars: false },
      mangle: {
        keepNames: { class: true, function: true },
        toplevel: false,
      },
    },
    polyfillRequire: false,
    preserveModules: true,
    preserveModulesRoot: SRC_ROOT,
    sourcemap: false,
    topLevelVar: false,
  },
  onLog: onVendoredDependencyLog,
});

const vueSourceFiles = await collectSourceFiles(join(SRC_ROOT, "vue"));

if (vueSourceFiles.length > 0) {
  const vueInput = Object.fromEntries(
    vueSourceFiles.map((sourcePath) => {
      const parsed = parse(sourcePath);
      return [join(parsed.dir, parsed.name).replaceAll("\\", "/"), sourcePath];
    }),
  );

  function isVueBuildExternal(source) {
    if (source.startsWith("#compiled/")) {
      return true;
    }

    if (source.startsWith("#")) {
      return false;
    }

    if (isBuiltin(source)) {
      return true;
    }

    for (const packageName of EXTERNAL_PACKAGES) {
      if (source === packageName || source.startsWith(`${packageName}/`)) {
        return true;
      }
    }

    return false;
  }

  await buildWithRolldown({
    input: vueInput,
    external: isVueBuildExternal,
    platform: "node",
    resolve: {
      conditionNames: ["eve-source"],
      mainFields: ["module", "main"],
    },
    treeshake: true,
    output: {
      chunkFileNames: "src/chunks/[name]-[hash].js",
      comments: false,
      dir: "dist",
      entryFileNames: "[name].js",
      format: "esm",
      minify: false,
      sourcemap: false,
    },
    onLog: onVendoredDependencyLog,
  });
}

const svelteSourceFiles = await collectSourceFiles(join(SRC_ROOT, "svelte"));

if (svelteSourceFiles.length > 0) {
  const svelteInput = Object.fromEntries(
    svelteSourceFiles.map((sourcePath) => {
      const parsed = parse(sourcePath);
      return [join(parsed.dir, parsed.name).replaceAll("\\", "/"), sourcePath];
    }),
  );

  function isSvelteBuildExternal(source) {
    if (source.startsWith("#compiled/")) {
      return true;
    }

    if (source.startsWith("#")) {
      return false;
    }

    if (isBuiltin(source)) {
      return true;
    }

    for (const packageName of EXTERNAL_PACKAGES) {
      if (source === packageName || source.startsWith(`${packageName}/`)) {
        return true;
      }
    }

    return false;
  }

  await buildWithRolldown({
    input: svelteInput,
    external: isSvelteBuildExternal,
    platform: "node",
    resolve: {
      conditionNames: ["eve-source"],
      mainFields: ["module", "main"],
    },
    treeshake: true,
    output: {
      chunkFileNames: "src/chunks/[name]-[hash].js",
      comments: false,
      dir: "dist",
      entryFileNames: "[name].js",
      format: "esm",
      minify: false,
      sourcemap: false,
    },
    onLog: onVendoredDependencyLog,
  });
}
