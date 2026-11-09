#!/usr/bin/env node
// Bundles the browser smoke scenario (`test/browser-smoke/page.ts`) and runs it in headless
// Chromium, in the page or in a Web Worker, twice: the second load restores the first's session
// from IndexedDB and reads the file its sandbox wrote there.
//
//   node scripts/browser-smoke.mjs [--worker] [--dist] [--keep]
//
// Built as another app's bundler builds a dependency for a page: plain esbuild, platform
// "browser", with no plugins, shims, polyfills or injected globals, defining only
// `process.env.NODE_ENV` (as Vite, webpack and esbuild do). A Node built-in anywhere in the
// graph, lazy imports included, fails the build. By default eve comes from its source (the
// `eve-source` condition); `--dist` bundles the package build (`pnpm build` first) instead.
// Needs playwright-core's chromium-headless-shell (`PLAYWRIGHT_BROWSERS_PATH`).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(PACKAGE_ROOT, "package.json"));
const esbuild = createRequire(require.resolve("vite"))("esbuild");

const args = process.argv.slice(2);
const IN_WORKER = args.includes("--worker");
const FROM_DIST = args.includes("--dist");
const OUT_DIR = join(PACKAGE_ROOT, ".generated/browser-smoke");

rmSync(OUT_DIR, { force: true, recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
const started = performance.now();
const built = await esbuild.build({
  absWorkingDir: PACKAGE_ROOT,
  bundle: true,
  conditions: FROM_DIST ? ["browser", "import"] : ["eve-source", "browser", "import"],
  define: { "process.env.NODE_ENV": '"development"' },
  entryPoints: { smoke: "test/browser-smoke/page.ts" },
  format: "esm",
  logLevel: "error",
  metafile: true,
  outdir: OUT_DIR,
  platform: "browser",
  sourcemap: "linked",
  splitting: true,
  target: "es2023",
  write: true,
});
const bundleMs = Math.round(performance.now() - started);
const jsOutputs = Object.entries(built.metafile.outputs).filter(([file]) => file.endsWith(".js"));
const bundleBytes = jsOutputs.reduce((n, [, output]) => n + output.bytes, 0);

writeFileSync(
  join(OUT_DIR, "index.html"),
  IN_WORKER
    ? `<!doctype html><script type="module">const worker = new Worker("/smoke.js" + location.search, { type: "module" }); worker.onmessage = (event) => { globalThis.__eveSmoke = event.data; }; worker.onerror = (event) => { globalThis.__eveSmoke = { ok: false, error: event.message, steps: [] }; };</script>`
    : `<!doctype html><script type="module" src="/smoke.js"></script>`,
);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json" };
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const path = join(OUT_DIR, pathname === "/" ? "index.html" : pathname.slice(1));
  if (!path.startsWith(OUT_DIR) || !existsSync(path)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
  response.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const url = `http://localhost:${typeof address === "object" && address !== null ? address.port : 0}/`;

const { chromium } = require("playwright-core");
const browser = await chromium.launch();
const logs = [];
const phases = [];
try {
  // One browser context for both loads, so the second sees the first's IndexedDB.
  const page = await browser.newPage();
  // Logged objects and errors expand (stack and cause), which `text()` reduces to a summary.
  page.on("console", (message) => {
    logs.push(
      Promise.all(
        message.args().map((arg) =>
          arg
            .evaluate((value) => {
              const show = (v, depth) => {
                if (v instanceof Error) {
                  const cause =
                    v.cause !== undefined && depth < 4
                      ? `\ncause: ${show(v.cause, depth + 1)}`
                      : "";
                  return `${v.stack ?? v.message}${cause}`;
                }
                if (typeof v === "object" && v !== null && depth < 3) {
                  return `{${Object.entries(v)
                    .map(([key, x]) => `${key}: ${show(x, depth + 1)}`)
                    .join(", ")}}`;
                }
                return String(v);
              };
              return show(value, 0);
            })
            .catch(() => "?"),
        ),
      ).then((parts) => `[${message.type()}] ${parts.join(" ")}`),
    );
  });
  let pageError;
  page.on("pageerror", (error) => {
    logs.push(`[pageerror] ${error.message}\n${error.stack ?? ""}`);
    pageError ??= error;
  });
  const runPhase = async (search) => {
    pageError = undefined;
    const phaseStarted = performance.now();
    await page.goto(`${url}${search}`);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && pageError === undefined) {
      if (await page.evaluate(() => globalThis.__eveSmoke !== undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await page.evaluate(
      () =>
        globalThis.__eveSmoke ?? {
          error: "no result: the scenario threw at load or timed out",
          ok: false,
          steps: [],
        },
    );
    return { ...result, ms: Math.round(performance.now() - phaseStarted) };
  };
  const first = await runPhase("");
  phases.push(first);
  if (first.ok && first.sessionId !== undefined) {
    phases.push(await runPhase(`?phase=resume&session=${encodeURIComponent(first.sessionId)}`));
  }
} finally {
  await browser.close();
  server.close();
}

const report = {
  bundle: {
    chunks: jsOutputs.length,
    kib: Math.round(bundleBytes / 1024),
    modules: Object.keys(built.metafile.inputs).length,
    ms: bundleMs,
  },
  from: FROM_DIST ? "dist" : "source",
  inWorker: IN_WORKER,
  logs: (await Promise.all(logs)).slice(0, 40),
  ok: phases.length === 2 && phases.every((phase) => phase.ok),
  phases,
};
console.log(JSON.stringify(report, null, 2));
if (!args.includes("--keep")) rmSync(OUT_DIR, { force: true, recursive: true });
process.exit(report.ok ? 0 : 1);
