#!/usr/bin/env node
// What a browser build of an eve entry reaches: its modules, their size, the files that import Node
// built-ins or name Node globals, and the Workflow runtime, which a Workflow-free entry must not
// reach at all. The session core's roots reach no Node built-in and no eve file naming a Node
// global.
//
//   node scripts/browser-reach.mjs [--entry src/execution/session/program.ts] [--json] [--chains]
//   node scripts/browser-reach.mjs --check    # fail on any Workflow module, or a metric past the baseline
//   node scripts/browser-reach.mjs --update   # rewrite the baseline
//   node scripts/browser-reach.mjs --why <path> [--cut a=>b,...]   # explain a module, or try a cut
//
// "Static" follows only static imports from the entry: what loads at startup. "Total" includes
// lazy `import()` targets too, since a bundler builds those as well. The entries are resolved as a
// browser bundler resolves them (the `browser` condition, no `node`), so each `#platform/*` module
// is its `.web.ts` twin. Node built-ins are left external and counted, not shimmed.
import { readFileSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(PACKAGE_ROOT, "scripts/browser-reach-baseline.json");
const require = createRequire(join(PACKAGE_ROOT, "package.json"));
// esbuild isn't a direct dependency of eve; vite (through vitest) brings one.
const esbuild = createRequire(require.resolve("vite"))("esbuild");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

/**
 * The entries that promise no Node built-in and no eve file naming a Node global: the session
 * core's host-neutral roots, which every host runs a session through (the session loop, the turn
 * step it runs, and a session's first-owner boot), the in-process host, which runs sessions
 * through them without Workflow, the internal embed entry's agent builder and sessions, and the
 * browser entry, which promises a page all of it.
 */
const NODE_FREE_ENTRIES = [
  "src/public/browser/index.ts",
  "src/execution/session/program.ts",
  "src/execution/session/turn-step.ts",
  "src/execution/session/owner-boot.ts",
  "src/execution/in-process/runtime.ts",
  "src/embed/agent.ts",
  "src/embed/session.ts",
];

/** The Workflow-free entries: the browser's, the session core's roots, the in-process host and embed. */
const ENTRIES = option("--entry", undefined)?.split(",") ?? [...NODE_FREE_ENTRIES];

/**
 * The Workflow runtime: Workflow's packages, and eve's modules under `internal/workflow/` that wrap
 * them. Not `internal/workflow-bundle/`: that's eve's build-time transform of authored Workflow
 * code, which imports no Workflow package and goes with the compiler and authored-module loader.
 */
const isWorkflowOwn = (s) => s.startsWith("internal/workflow/") || s.startsWith("gen:@workflow/");

/**
 * Whether the module at short path `s` is the Workflow runtime. The vendoring build files the
 * chunks Workflow shares with the AI SDK and OpenTelemetry under `_chunks/workflow/` too, so such a
 * chunk counts only when nothing but Workflow reaches it (`sharedWithoutWorkflow`).
 */
const isWorkflow = (s, sharedWithoutWorkflow) =>
  isWorkflowOwn(s) || (s.startsWith("gen:_chunks/workflow") && !sharedWithoutWorkflow.has(s));

// Node globals a module names without importing them. A browser bundler provides none (Vite,
// webpack 5 and esbuild only define `process.env.NODE_ENV`), so a browser-path module that reads
// one breaks there. Counted with esbuild's `define`, which replaces only free references: not a
// member such as `globalThis.process`, nor a local of the same name.
const NODE_GLOBALS = [
  "Buffer",
  "process",
  "global",
  "setImmediate",
  "clearImmediate",
  "__dirname",
  "__filename",
];
const GLOBAL_SENTINEL = "__eveNodeGlobal_";
const nodeGlobalsCache = new Map();
/** The Node globals the module at `path` (relative to the package) names. */
function nodeGlobalsOf(path) {
  if (nodeGlobalsCache.has(path)) return nodeGlobalsCache.get(path);
  let found = [];
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    // `process.env.NODE_ENV` is what every bundler defines, so it isn't a use. It becomes an opaque
    // name, not a string: a constant would fold its branches away, and a development build runs
    // the other one.
    const source = readFileSync(join(PACKAGE_ROOT, path), "utf8").replace(
      /(?<![\w$.])process\.env\.NODE_ENV\b/g,
      "__eveNodeEnv",
    );
    const loader = /\.[cm]?tsx?$/.test(path) ? (path.endsWith("x") ? "tsx" : "ts") : "js";
    const { code } = esbuild.transformSync(source, {
      define: Object.fromEntries(NODE_GLOBALS.map((name) => [name, `${GLOBAL_SENTINEL}${name}`])),
      format: "esm",
      loader,
    });
    found = NODE_GLOBALS.filter((name) => code.includes(`${GLOBAL_SENTINEL}${name}`));
  }
  nodeGlobalsCache.set(path, found);
  return found;
}

const builtins = new Set(builtinModules);
const isBuiltin = (path) => path.startsWith("node:") || builtins.has(path);

const short = (p) =>
  p
    .replace(/.*packages\/eve\/src\//, "")
    .replace(/^src\//, "")
    .replace(/.*\.generated\/compiled\//, "gen:")
    .replace(/.*node_modules\/\.pnpm\/[^/]+\/node_modules\//, "dep:");

// `--cut a=>b,c=>d` simulates removing the imports from module `a` to modules starting with `b`
// (short paths), to see what a seam would save before making it.
const cuts = (option("--cut", "") ?? "")
  .split(",")
  .filter(Boolean)
  .map((pair) => pair.split("=>"));
const isCut = (from, to) => cuts.some(([a, b]) => short(from) === a && short(to).startsWith(b));

async function measure(entry) {
  const result = await esbuild
    .build({
      absWorkingDir: PACKAGE_ROOT,
      bundle: true,
      conditions: ["eve-source", "browser", "import"],
      entryPoints: [entry],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      outfile: "browser-reach.js",
      platform: "browser",
      plugins: [
        {
          name: "node-builtins",
          setup(build) {
            build.onResolve({ filter: /.*/ }, ({ path }) =>
              isBuiltin(path) ? { external: true, path } : undefined,
            );
          },
        },
      ],
      write: false,
    })
    .catch((error) => ({ errors: error.errors ?? [{ text: String(error) }] }));
  if (result.errors?.length) {
    return { entry, errors: result.errors.map((e) => `${e.text} (${e.location?.file ?? "?"})`) };
  }
  const { metafile } = result;
  const output = Object.values(metafile.outputs)[0];
  const bytesOf = (p) => output.inputs[p]?.bytesInOutput ?? 0;
  const entryPath = Object.keys(metafile.inputs).find((p) =>
    p.endsWith(entry.replace(/^\.\//, "")),
  );

  /** What the entry reaches; `stopAt` names modules not to look past. */
  const reach = (followDynamic, stopAt = () => false) => {
    const seen = new Set([entryPath]);
    const previous = new Map();
    const queue = [entryPath];
    while (queue.length > 0) {
      const node = queue.shift();
      if (node !== entryPath && stopAt(short(node))) continue;
      for (const edge of metafile.inputs[node]?.imports ?? []) {
        if (edge.external || (!followDynamic && edge.kind === "dynamic-import")) continue;
        if (isCut(node, edge.path) || seen.has(edge.path)) continue;
        seen.add(edge.path);
        previous.set(edge.path, node);
        queue.push(edge.path);
      }
    }
    return { previous, seen };
  };
  const chainOf = (previous, target) => {
    const chain = [];
    for (let node = target; node !== undefined; node = previous.get(node)) {
      chain.unshift(short(node));
    }
    return chain.join(" -> ");
  };

  const why = option("--why", undefined);
  const explain = (followDynamic) => {
    if (why === undefined) return undefined;
    const { previous, seen } = reach(followDynamic);
    const hit = [...seen].find((p) => short(p).includes(why));
    return hit === undefined ? `${why}: not reached` : `${why}: ${chainOf(previous, hit)}`;
  };

  const summarize = (followDynamic) => {
    const { previous, seen } = reach(followDynamic);
    let bytes = 0;
    for (const p of seen) bytes += bytesOf(p);
    const builtinFiles = new Set();
    const builtinModulesReached = new Set();
    for (const p of seen) {
      for (const edge of metafile.inputs[p]?.imports ?? []) {
        if (!edge.external || !isBuiltin(edge.path)) continue;
        if (!followDynamic && edge.kind === "dynamic-import") continue;
        builtinFiles.add(p);
        builtinModulesReached.add(edge.path.replace(/^node:/, ""));
      }
    }
    const sharedWithoutWorkflow = new Set(
      [...reach(followDynamic, isWorkflowOwn).seen].map(short).filter((s) => !isWorkflowOwn(s)),
    );
    const workflow = [...seen].filter((p) => isWorkflow(short(p), sharedWithoutWorkflow));
    const globalFiles = {};
    for (const p of seen) {
      const names = nodeGlobalsOf(p);
      if (names.length > 0) globalFiles[short(p)] = names;
    }
    return {
      builtinFiles: [...builtinFiles].map(short).sort(),
      builtinModules: [...builtinModulesReached].sort(),
      bytes,
      eveModules: [...seen].filter((p) => /^(src\/|.*packages\/eve\/src\/)/.test(p)).length,
      globalFiles,
      list: [...seen].map(short).sort(),
      modules: seen.size,
      workflow: workflow.length,
      // The first Workflow module, by the chain that reaches it: where the seam is missing.
      workflowChain: workflow.length > 0 ? chainOf(previous, workflow[0]) : undefined,
    };
  };

  return {
    entry,
    static: summarize(false),
    total: summarize(true),
    why: { static: explain(false), total: explain(true) },
  };
}

const isVendored = (shortPath) => shortPath.startsWith("gen:") || shortPath.startsWith("dep:");

/** The numbers the baseline holds; each may only shrink. */
function guardedMetrics(report) {
  const metrics = {};
  for (const reach of ["static", "total"]) {
    const s = report[reach];
    metrics[`${reach}.modules`] = s.modules;
    metrics[`${reach}.kib`] = Math.round(s.bytes / 1024);
    metrics[`${reach}.builtinFiles`] = s.builtinFiles.length;
    // eve's own modules and the third-party ones it bundles, apart: what a fix must reach differs.
    metrics[`${reach}.globalFiles`] = Object.keys(s.globalFiles).filter(
      (p) => !isVendored(p),
    ).length;
    metrics[`${reach}.vendorGlobalFiles`] = Object.keys(s.globalFiles).filter(isVendored).length;
    metrics[`${reach}.workflow`] = s.workflow;
  }
  return metrics;
}

const reports = [];
for (const entry of ENTRIES) reports.push(await measure(entry));

const failed = reports.filter((r) => r.errors !== undefined);
for (const r of failed) {
  console.error(`${r.entry}: ${r.errors.length} build errors`);
  for (const e of r.errors.slice(0, 20)) console.error(`  ${e}`);
}
if (failed.length > 0) process.exit(2);

if (flag("--json")) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  for (const r of reports) {
    console.log(`\n${r.entry}`);
    for (const kind of ["static", "total"]) {
      const s = r[kind];
      console.log(
        `  ${kind.padEnd(6)} ${String(s.modules).padStart(5)} modules (${s.eveModules} eve), ` +
          `${(s.bytes / 1024).toFixed(0).padStart(6)} KiB, ${s.workflow} Workflow, ` +
          `${s.builtinFiles.length} files importing Node built-ins (${s.builtinModules.join(", ") || "none"}), ` +
          `${Object.keys(s.globalFiles).length} naming Node globals`,
      );
      if (s.workflowChain !== undefined) console.log(`    Workflow via ${s.workflowChain}`);
    }
    if (r.why.static !== undefined) {
      console.log(`  why (static): ${r.why.static}\n  why (total): ${r.why.total}`);
    }
    if (flag("--chains")) {
      console.log("  files importing Node built-ins (total):");
      for (const f of r.total.builtinFiles) console.log(`    ${f}`);
      console.log("  files naming Node globals (total):");
      for (const [f, names] of Object.entries(r.total.globalFiles)) {
        console.log(`    ${f}: ${names.join(", ")}`);
      }
    }
  }
}

if (flag("--check") || flag("--update")) {
  // A Workflow-free entry reaches no Workflow module, static or lazy; no baseline can allow one.
  const workflow = reports.flatMap((r) =>
    ["static", "total"]
      .filter((kind) => r[kind].workflow > 0)
      .map((kind) => `${r.entry} ${kind}: ${r[kind].workflow} via ${r[kind].workflowChain}`),
  );
  if (workflow.length > 0) {
    console.error("\nWorkflow-free entries reach the Workflow runtime:");
    for (const w of workflow) console.error(`  ${w}`);
    process.exit(1);
  }
  // Nor does a Node-free entry reach a Node built-in, or an eve file naming a Node global.
  // (Vendored code may name one behind a `typeof` check; the baseline holds how many files do.)
  const node = reports
    .filter((r) => NODE_FREE_ENTRIES.includes(r.entry))
    .flatMap((r) => [
      ...r.total.builtinFiles.map((f) => `${r.entry}: ${f} imports a Node built-in`),
      ...Object.entries(r.total.globalFiles)
        .filter(([f]) => !isVendored(f))
        .map(([f, names]) => `${r.entry}: ${f} names ${names.join(", ")}`),
    ]);
  if (node.length > 0) {
    console.error("\nThe Node-free entries reach Node:");
    for (const n of node) console.error(`  ${n}`);
    process.exit(1);
  }
  const current = Object.fromEntries(reports.map((r) => [r.entry, guardedMetrics(r)]));
  if (flag("--update")) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`\nwrote ${relative(PACKAGE_ROOT, BASELINE_PATH)}`);
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const grew = [];
    for (const [entry, metrics] of Object.entries(current)) {
      for (const [name, value] of Object.entries(metrics)) {
        const limit = baseline[entry]?.[name];
        if (limit === undefined || value > limit) {
          grew.push(`${entry} ${name}: ${value} > ${limit ?? "unset"}`);
        }
      }
    }
    if (grew.length > 0) {
      console.error("\nbrowser reach grew past the baseline (baselines may only shrink):");
      for (const g of grew) console.error(`  ${g}`);
      process.exit(1);
    }
    console.log("\nbrowser reach is within the baseline");
  }
}
