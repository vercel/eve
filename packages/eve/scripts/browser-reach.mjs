#!/usr/bin/env node
// What an eve entry reaches: its modules, their size, the files that import Node built-ins, and the
// Workflow runtime, which a Workflow-free entry must not reach at all.
//
//   node scripts/browser-reach.mjs [--entry src/execution/session/program.ts] [--json] [--chains]
//   node scripts/browser-reach.mjs --check    # fail on any Workflow module, or a metric past the baseline
//   node scripts/browser-reach.mjs --update   # rewrite the baseline
//   node scripts/browser-reach.mjs --why <path> [--cut a=>b,...]   # explain a module, or try a cut
//
// "Static" follows only static imports from the entry: what loads at startup. "Total" includes
// lazy `import()` targets too, since a bundler builds those as well. The entries are resolved as
// Node resolves them, where every host of the session core runs. Node built-ins are left external
// and counted.
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
 * The Workflow-free entries: the session core's host-neutral roots, which every host runs a
 * session through. The session loop, the turn step it runs, and a session's first-owner boot.
 */
const ENTRIES = option("--entry", undefined)?.split(",") ?? [
  "src/execution/session/program.ts",
  "src/execution/session/turn-step.ts",
  "src/execution/session/owner-boot.ts",
];

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
/**
 * Edges no Workflow-free entry follows, each with why. Sandbox prewarm under `eve dev` loads the
 * app's authored modules, and so Workflow, but only in development, from a build on disk.
 */
const DEVELOPMENT_ONLY = [
  ["execution/sandbox/ensure.ts", "execution/sandbox/development-lazy-prewarm.ts"],
];
const cuts = [
  ...DEVELOPMENT_ONLY,
  ...(option("--cut", "") ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("=>")),
];
const isCut = (from, to) => cuts.some(([a, b]) => short(from) === a && short(to).startsWith(b));

async function measure(entry) {
  const result = await esbuild
    .build({
      absWorkingDir: PACKAGE_ROOT,
      bundle: true,
      conditions: ["eve-source", "node", "import"],
      entryPoints: [entry],
      // just-bash's optional codecs, which it loads only if they're installed.
      external: ["node-liblzma", "@mongodb-js/zstd"],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      outfile: "browser-reach.js",
      platform: "node",
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
    return {
      builtinFiles: [...builtinFiles].map(short).sort(),
      builtinModules: [...builtinModulesReached].sort(),
      bytes,
      eveModules: [...seen].filter((p) => /^(src\/|.*packages\/eve\/src\/)/.test(p)).length,
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

/** The numbers the baseline holds; each may only shrink. */
function guardedMetrics(report) {
  const metrics = {};
  for (const reach of ["static", "total"]) {
    const s = report[reach];
    metrics[`${reach}.modules`] = s.modules;
    metrics[`${reach}.kib`] = Math.round(s.bytes / 1024);
    metrics[`${reach}.builtinFiles`] = s.builtinFiles.length;
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
          `${s.builtinFiles.length} files importing Node built-ins (${s.builtinModules.join(", ") || "none"})`,
      );
      if (s.workflowChain !== undefined) console.log(`    Workflow via ${s.workflowChain}`);
    }
    if (r.why.static !== undefined) {
      console.log(`  why (static): ${r.why.static}\n  why (total): ${r.why.total}`);
    }
    if (flag("--chains")) {
      console.log("  startup files importing Node built-ins:");
      for (const f of r.static.builtinFiles) console.log(`    ${f}`);
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
