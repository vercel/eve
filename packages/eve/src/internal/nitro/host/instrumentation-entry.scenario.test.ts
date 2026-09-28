import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build, createNitro, prepare } from "nitro/builder";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useTemporaryAppRoots,
  useTemporaryDirectories,
} from "#internal/testing/use-temporary-app-roots.js";
import { configureInstrumentationEntry } from "#internal/nitro/host/instrumentation-entry.js";
import { buildApplication } from "#internal/nitro/host.js";

vi.mock("#internal/nitro/host/vercel-build-prewarm.js", () => ({
  runVercelBuildPrewarm: async () => true,
}));

const execFileAsync = promisify(execFile);
const createDirectory = useTemporaryDirectories();
const createAppRoot = useTemporaryAppRoots();

afterEach(() => vi.unstubAllEnvs());

describe("instrumentation before the Nitro entry", () => {
  it.each(["vercel-web", "vercel-node", "node-server", "development", "setup-failure"])(
    "awaits asynchronous setup before application imports with %s",
    async (target) => {
      const root = await createDirectory("eve-instrumentation-entry-");
      const driverDirectory = join(root, "node_modules", "fixture-driver");
      await mkdir(driverDirectory, { recursive: true });
      await writeFile(
        join(driverDirectory, "package.json"),
        JSON.stringify({ name: "fixture-driver", version: "1.0.0", main: "index.cjs" }),
      );
      await writeFile(
        join(driverDirectory, "index.cjs"),
        "globalThis.startup.push(`driver:${globalThis.instrumentationReady === true}`);",
      );
      const instrumentationPath = join(root, "instrumentation.mjs");
      await writeFile(
        instrumentationPath,
        [
          'import { setImmediate } from "node:timers/promises";',
          "await setImmediate();",
          ...(target === "setup-failure"
            ? ["throw new Error('Instrumentation setup failed');"]
            : []),
          "globalThis.instrumentationReady = true;",
          "globalThis.startup.push('instrumentation');",
          "export default app => {",
          "  app.hooks.hook('close', () => globalThis.startup.push('shutdown'));",
          "  globalThis.closeNitro = () => app.hooks.callHook('close');",
          "};",
        ].join("\n"),
      );
      const applicationPath = join(root, "application.mjs");
      await writeFile(applicationPath, 'import "fixture-driver"; export default () => {};');
      const nitro = await createNitro({
        rootDir: root,
        dev: target === "development",
        preset: target === "node-server" ? "node-server" : "vercel",
        vercel: { entryFormat: target === "vercel-node" ? "node" : "web" },
        logLevel: 0,
        plugins: [applicationPath, instrumentationPath],
        traceDeps: ["fixture-driver"],
        rollupConfig: { external: ["fixture-driver"] },
      });
      configureInstrumentationEntry(nitro, instrumentationPath);

      try {
        await prepare(nitro);
        const compiled = new Promise<void>((resolve) =>
          nitro.hooks.hookOnce("compiled", () => resolve()),
        );
        await build(nitro);
        await compiled;
        const entry = pathToFileURL(join(nitro.options.output.serverDir, "index.mjs")).href;
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `globalThis.startup = [];
           try {
             const { default: server } = await import(${JSON.stringify(entry)});
             await import(${JSON.stringify(entry)});
             if (${JSON.stringify(target)} === 'vercel-web' && typeof server.fetch !== 'function') throw new Error('Missing Vercel fetch handler');
             if (${JSON.stringify(target)} === 'vercel-node' && typeof server !== 'function') throw new Error('Missing Vercel Node handler');
             if (${JSON.stringify(target)} === 'development' && typeof server.ipc.onClose !== 'function') throw new Error('Missing development close handler');
             await globalThis.closeNitro();
           } catch (error) {
             globalThis.startup.push(error.message);
           }
           console.log('RESULT ' + JSON.stringify(globalThis.startup));
           process.exit(0);`,
          ],
          {
            cwd: root,
            env: { ...process.env, NITRO_PORT: "0", NITRO_HOST: "127.0.0.1" },
            timeout: 10_000,
          },
        );
        const result = stdout.split("\n").find((line) => line.startsWith("RESULT "));
        expect(JSON.parse(result!.slice("RESULT ".length))).toEqual(
          target === "setup-failure"
            ? ["Instrumentation setup failed"]
            : ["instrumentation", "driver:true", "shutdown"],
        );
      } finally {
        await nitro.close();
      }
    },
  );

  it("registers the authored OTel pipeline before eve's external tool dependencies load", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    const { appRoot } = await createAppRoot("eve-instrumentation-tool-dependency-", {
      files: {
        "package.json": JSON.stringify({
          name: "instrumentation-tool-dependency",
          type: "module",
          dependencies: { "fixture-driver": "1.0.0" },
        }),
        "agent/agent.mjs":
          'export default { model: "openai/gpt-5.4-mini", build: { externalDependencies: ["fixture-driver"] } };',
        "agent/instructions.md": "Help Alice check her database.",
        "agent/tools/check.mjs": [
          'import { defineTool } from "eve/tools";',
          'import driver from "fixture-driver";',
          'export default defineTool({ description: "Check the database.", inputSchema: {}, execute: () => driver });',
        ].join("\n"),
        "agent/instrumentation/audit.mjs": [
          'import { setImmediate } from "node:timers/promises";',
          'import { defineInstrumentation } from "eve/instrumentation";',
          "export default defineInstrumentation({ async setup() {",
          "  await setImmediate();",
          "  globalThis.startup.push('setup');",
          "} });",
        ].join("\n"),
        "agent/instrumentation/otel.mjs": [
          'import { otel } from "eve/instrumentation/otel";',
          "export default otel({ instrumentations: [{",
          "  getConfig: () => ({ enabled: false }),",
          "  setTracerProvider() {}, setMeterProvider() {}, disable() {},",
          "  enable() { globalThis.instrumentationReady = true; globalThis.startup.push('instrumentation'); },",
          "}] });",
        ].join("\n"),
        "node_modules/fixture-driver/package.json": JSON.stringify({
          name: "fixture-driver",
          version: "1.0.0",
          main: "index.cjs",
        }),
        "node_modules/fixture-driver/index.cjs": [
          "const ready = globalThis.instrumentationReady === true;",
          "(globalThis.startup ??= []).push(`driver:${ready}`);",
          "module.exports = { ready };",
        ].join("\n"),
      },
    });
    const output = await buildApplication(appRoot, { skipSandboxPrewarm: false });
    for (const functionPath of ["__server.func", ".well-known/workflow/v1/flow.func"]) {
      const entry = pathToFileURL(join(output, "functions", functionPath, "index.mjs")).href;
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `globalThis.startup = [];
         const { default: server } = await import(${JSON.stringify(entry)});
         const response = await server.fetch(new Request('http://localhost/eve/v1/health'), { waitUntil() {} });
         if (response.status !== 200) throw new Error(await response.text());
         console.log(JSON.stringify({ status: response.status, startup: globalThis.startup }));
         process.exit(0);`,
        ],
        {
          cwd: appRoot,
          env: { ...process.env, VERCEL_DEPLOYMENT_ID: "dpl_instrumentation_entry_test" },
          timeout: 10_000,
        },
      );
      expect(JSON.parse(stdout.trim())).toEqual({
        status: 200,
        startup: ["setup", "instrumentation", "driver:true"],
      });
    }
  });
});
