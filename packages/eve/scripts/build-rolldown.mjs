/**
 * Single rolldown invocation that emits every `src/**\/*.ts` to its
 * matching `dist/src/**\/*.js` location, minified and comment-stripped.
 *
 * Replaces TypeScript JS emit and the secondary cli/evals bundler.
 * `tsc` continues to emit `.d.ts` files only; this script owns every
 * shipped `.js` byte.
 *
 * Topology: `preserveModules: true` keeps the 1:1 source-to-output
 * mapping the runtime expects (workflow builder per-file discovery,
 * `imports#*.js` runtime resolution, `bin/eve.js` -> `dist/src/cli/run.js`,
 * etc.). The `eve-source` resolver condition makes `#*.js` follow
 * `./src/*.ts` so sibling imports become part of the graph.
 * `#compiled/*` and peer/runtime packages stay external.
 */
import { readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, parse, relative } from "node:path";

import { buildWithNitroRolldown } from "./nitro-rolldown.mjs";
import { createVendoredDependencyWarningFilter } from "./vendor-warning-log.mjs";

/**
 * Names of the CJS-interop helpers that rolldown injects into its
 * virtual runtime file. We strip the side-effect import of that file
 * from emitted chunks that never reference one of these — otherwise
 * every eve dist module imports `node:module` transitively, and any
 * downstream bundler (notably the workflow bundle) that ingests the
 * dist tree under a non-Node platform warns about an unresolved
 * builtin on every input file.
 */
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

/**
 * Applies the same `defineDynamic` execute-hoisting transform that the
 * agent's Nitro build applies to authored `agent/tools/*.ts` files. This
 * lets framework dynamic tools ship pre-transformed so they replay
 * across workflow step boundaries identically to authored tools.
 */
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

const SRC_ROOT = "src";
const OUTPUT_DIR = "dist/src";

const EXCLUDED_FILE_PATTERNS = [
  /\.test\.ts$/,
  /\.integration\.test\.ts$/,
  /\.scenario\.test\.ts$/,
  /\.e2e\.test\.ts$/,
  // On-demand web-template generator, not shipped runtime. Mirrors the
  // src/setup/build.ts entry in tsconfig.build.json's exclude.
  /\/setup\/build\.ts$/,
];

// Subtrees of `src/` that are pure test infrastructure. Mirrors the
// `exclude` list in `tsconfig.build.json` so the dist tree contains
// exactly the same set of compilation units the declaration emit covers.
const EXCLUDED_DIRECTORIES = new Set([join("internal", "testing")]);

/**
 * Packages externalized at bundle time so rolldown never inlines them
 * into eve's dist tree. Three categories:
 *
 *   - Peer dependencies (`ai`, `next`, `react`, `@opentelemetry/api`,
 *     `braintrust`) — consumers provide the install.
 *   - Runtime dependencies (`nitro`) — resolved at
 *     runtime against the eve installation.
 *   - Optional peer dependency (`just-bash`) — the opt-in local sandbox
 *     engine; resolved lazily against the consumer's install and never
 *     bundled with eve.
 *
 * `#compiled/*` is also external (handled separately) so the vendored
 * dependency tree under `dist/src/compiled/**` resolves at runtime via
 * the package `imports` map.
 */
const EXTERNAL_PACKAGES = new Set([
  "@nuxt/kit",
  "@opentelemetry/api",
  "@sveltejs/kit",
  "ai",
  "braintrust",
  "just-bash",
  "microsandbox",
  "next",
  "nitro",
  "react",
  "svelte",
  "vite",
  "vue",
]);

function isExternalPackageSpecifier(source) {
  // All `#*` subpath imports stay external so the published dist keeps
  // the bare-specifier shape the runtime resolves at load time. Source
  // files routinely depend on a 1:1 mapping (workflow
  // builder, instrumentation, etc.) and the workflow bundler needs the
  // `eve-source` condition to follow these specifiers back to the
  // matching `.ts` source rather than into the published `.js` tree.
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

// `input` is a map of "src-relative path without extension" -> absolute
// source. `preserveModules` writes each entry to
// `${output.dir}/${entryName}.js`, which (with `preserveModulesRoot:
// "src"` and `output.dir: "dist/src"`) lands at `dist/src/<rel>.js`.
const input = Object.fromEntries(
  sourceFiles.map((sourcePath) => {
    const relativeFromSrc = relative(SRC_ROOT, sourcePath);
    const parsed = parse(relativeFromSrc);
    const entryName = join(parsed.dir, parsed.name).replaceAll("\\", "/");
    return [entryName, sourcePath];
  }),
);

const warningFilter = createVendoredDependencyWarningFilter();

await buildWithNitroRolldown({
  input,
  external: isExternalPackageSpecifier,
  platform: "node",
  plugins: [createStripUnusedRolldownRuntimeImportPlugin(), createDynamicToolTransformPlugin()],
  resolve: {
    // `eve-source` makes `#*.js` resolve to `./src/*.ts` at build time so
    // sibling source files become part of the graph instead of bare
    // imports rolldown would refuse to follow.
    conditionNames: ["eve-source", "node", "import"],
    mainFields: ["module", "main"],
  },
  treeshake: false,
  output: {
    comments: false,
    dir: OUTPUT_DIR,
    entryFileNames: "[name].js",
    format: "esm",
    minify: {
      mangle: {
        keepNames: { class: true, function: true },
        // Disable top-level renaming so the workflow bundler's scope-
        // blind identifier-reference walk (`stripUnusedValueImports`)
        // can correctly tell that single-letter import bindings are
        // unused after step bodies get stubbed. Without this rolldown
        // mangles imports to `e`, `t`, `n`, … which collide with the
        // many short locals minify introduces inside function bodies.
        toplevel: false,
      },
    },
    // Skip rolldown's CJS-interop `__require` polyfill so the virtual
    // runtime helper file doesn't import `node:module`. Without this
    // every dist file would carry an `import "../_virtual/_rolldown/runtime.js"`
    // side-effect import, and the workflow bundler (which runs under
    // `platform: "neutral"`) would warn about the unresolved Node
    // builtin every time it pulled an eve file into its graph.
    polyfillRequire: false,
    preserveModules: true,
    preserveModulesRoot: SRC_ROOT,
    sourcemap: false,
    // Keep `let`/`const` at the top level so module-evaluation cycles
    // surface as a loud TDZ `ReferenceError` at module load rather than
    // silent `undefined` reads deep inside the runtime.
    topLevelVar: false,
  },
  onLog: warningFilter.onLog,
});

// Vue integration — separate build that resolves `#` subpath imports so the
// output is self-contained and consumable by Vite/bundlers that don't
// understand Node.js package `imports`. Without minification so Vite's SSR
// transform doesn't choke on minified export-alias / local-variable collisions.
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

  await buildWithNitroRolldown({
    input: vueInput,
    external: isVueBuildExternal,
    platform: "node",
    resolve: {
      conditionNames: ["eve-source", "node", "import"],
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
    onLog: warningFilter.onLog,
  });
}

// Svelte integration — separate build that resolves `#` subpath imports so the
// output is self-contained and consumable by Vite/bundlers that don't
// understand Node.js package `imports`.
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

  await buildWithNitroRolldown({
    input: svelteInput,
    external: isSvelteBuildExternal,
    platform: "node",
    resolve: {
      conditionNames: ["eve-source", "node", "import"],
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
    onLog: warningFilter.onLog,
  });
}
