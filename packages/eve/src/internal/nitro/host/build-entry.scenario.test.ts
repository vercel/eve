import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { buildApplication, startProductionServer } from "#internal/nitro/host.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const execFileAsync = promisify(execFile);
const createAppRoot = useTemporaryAppRoots();

const AGENT_FILES = {
  "agent/agent.mjs":
    'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4-mini" });',
  "agent/instructions.md": "Help Alice plan her week.\n",
  "agent/channels/notes.mjs": [
    'import { defineChannel, POST } from "eve/channels";',
    'import { setTimeout } from "node:timers/promises";',
    'import { archiveLabel } from "legacy-archive";',
    "export default defineChannel({",
    "  routes: [",
    '    POST("/notes", (_request, { waitUntil }) => {',
    "      waitUntil(setTimeout(20).then(() => { globalThis.noteSaved = true; }));",
    '      return new Response("accepted", { status: 202 });',
    "    }),",
    '    POST("/notes/label", () => new Response(archiveLabel)),',
    '    POST("/notes/archive", (_request, { waitUntil }) => {',
    '      const cause = new Error("The archive is full.");',
    '      waitUntil(Promise.reject(new Error("Bob could not archive his notes.", { cause })));',
    '      return new Response("accepted", { status: 202 });',
    "    }),",
    "  ],",
    "});",
  ].join("\n"),
  "agent/instrumentation/audit.mjs": [
    'import { setTimeout } from "node:timers/promises";',
    'import { defineInstrumentation } from "eve/instrumentation";',
    "export default defineInstrumentation({",
    "  async setup() {",
    "    await setTimeout(20);",
    "    globalThis.auditReady = true;",
    "  },",
    "});",
  ].join("\n"),
  "node_modules/legacy-archive/package.json": JSON.stringify({
    name: "legacy-archive",
    version: "1.0.0",
    main: "lib/index.js",
  }),
  "node_modules/legacy-archive/lib/index.js": 'exports.archiveLabel = "Alice\'s archive";',
  "platform/app.mjs": [
    'import "eve:instrumentation";',
    'import { start } from "eve:app";',
    "globalThis.platformAppLoads = (globalThis.platformAppLoads ?? 0) + 1;",
    "let started;",
    "export const app = () => (started ??= start());",
  ].join("\n"),
  "platform/served-entry.mjs": [
    'import { app } from "./app.mjs";',
    "export default {",
    "  async fetch(request) {",
    "    return (await app()).fetch(request);",
    "  },",
    "};",
  ].join("\n"),
  "platform/engine-worker.mjs": [
    'import { app } from "./app.mjs";',
    "export async function handle(request) {",
    "  return (await app()).fetch(request);",
    "}",
  ].join("\n"),
  "platform/bare-entry.mjs": [
    'import { start } from "eve:app";',
    "export default {",
    "  async fetch(request) {",
    "    return (await start()).fetch(request);",
    "  },",
    "};",
  ].join("\n"),
  "platform/entry.mjs": [
    'import "eve:instrumentation";',
    'import { start } from "eve:app";',
    "let started;",
    "const app = () => (started ??= start());",
    "export const startAgain = () => start();",
    "export class EveSession {",
    '  kind = "platform-export";',
    "}",
    "export default {",
    "  async fetch(request, _env, context) {",
    "    return (await app()).fetch(request, { waitUntil: (work) => context.waitUntil(work) });",
    "  },",
    "};",
  ].join("\n"),
};

const DRIVER = `
const entry = await import(process.env.ENTRY_URL);
const auditReadyAtImport = globalThis.auditReady === true;
const work = [];
const send = (path, init) =>
  entry.default.fetch(new Request("http://localhost" + path, init), {}, { waitUntil: (promise) => work.push(promise) });
const health = await send("/eve/v1/health");
const auditReadyAtFirstResponse = globalThis.auditReady === true;
const info = await send("/eve/v1/info");
const notes = await send("/notes", { method: "POST" });
const label = await (await send("/notes/label", { method: "POST" })).text();
const savedBeforeWork = globalThis.noteSaved === true;
const logged = [];
const consoleError = console.error;
console.error = (...args) => logged.push(args);
await send("/notes/archive", { method: "POST" });
await Promise.all(work);
console.error = consoleError;
const archiveFailure = logged.find(([line]) => String(line).includes("channel background task failed"));
const secondStart = await entry.startAgain().then(() => "started", (error) => error.message);
console.log("RESULT " + JSON.stringify({
  exports: Object.keys(entry).sort(),
  auditReadyAtImport,
  auditReadyAtFirstResponse,
  session: new entry.EveSession().kind,
  health: health.status,
  info: info.status,
  notes: notes.status,
  label,
  savedBeforeWork,
  savedAfterWork: globalThis.noteSaved === true,
  secondStart,
  loggedCause:
    archiveFailure === undefined
      ? "not logged"
      : archiveFailure[1].error.detail.split("\\n").includes("[cause]:")
        ? "web twin"
        : "node twin",
}));
process.exit(0);
`;

async function runEntry(appRoot: string, outputDir: string, driver: string): Promise<unknown> {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd: appRoot,
    env: {
      ...process.env,
      ENTRY_URL: pathToFileURL(join(outputDir, "server", "index.mjs")).href,
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: "0",
      NITRO_PRESET: "",
      WORKER_URL: pathToFileURL(join(outputDir, "server", "engine-worker.mjs")).href,
    },
    timeout: 60_000,
  });
  const result = stdout.split("\n").find((line) => line.startsWith("RESULT "));
  return JSON.parse(result!.slice("RESULT ".length));
}

const WORKER_ENGINE = `() => ({
  build: { entries: { "engine-worker": "platform/engine-worker.mjs" } },
  start: () => ({}) as never,
})`;

const HEALTH_FROM_WORKER = `
const worker = await import(process.env.WORKER_URL);
const { status } = await worker.handle(new Request("http://localhost/eve/v1/health"));
const listening = process.getActiveResourcesInfo().includes("TCPServerWrap");
console.log("RESULT " + JSON.stringify({ health: status, appLoads: globalThis.platformAppLoads, listening }));
process.exit(0);
`;

async function buildWithPlatform(
  appRoot: string,
  build: string,
  options: { readonly durable?: string; readonly profileOutputPath?: string } = {},
): Promise<string> {
  const { durable, ...buildOptions } = options;
  const declaration = resolvePackageSourceFilePath("src/platform/declaration.ts");
  await writeFile(
    join(appRoot, "platform", "declaration.ts"),
    [
      'import { join } from "node:path";',
      `import { definePlatform } from ${JSON.stringify(declaration)};`,
      "export default definePlatform({",
      "  deployment: () => ({",
      "    environment: () => undefined,",
      `    deploymentId: () => ${durable === undefined ? "undefined" : '"dpl_alice"'},`,
      "    host: () => undefined,",
      "    scope: () => undefined,",
      "  }),",
      "  triggers: () => {",
      `    throw new Error("The platform's triggers factory ran during the build.");`,
      "  },",
      `  build: ${build},`,
      ...(durable === undefined ? [] : [`  durable: ${durable},`]),
      "});",
    ].join("\n"),
  );
  return await buildApplication(appRoot, {
    ...buildOptions,
    platformModule: "platform/declaration.ts",
    skipSandboxPrewarm: true,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a build with a platform entry", () => {
  it("bundles the entry as the server, registers instrumentation without top-level await, and serves eve through start() from eve:app", async () => {
    vi.stubEnv("NITRO_PRESET", "node-server");
    vi.stubEnv("VERCEL", "");
    const { appRoot } = await createAppRoot("eve-build-entry-", { files: AGENT_FILES });
    const profileOutputPath = join(appRoot, "build-profile.json");

    const outputDir = await buildWithPlatform(appRoot, '{ entry: "platform/entry.mjs" }', {
      profileOutputPath,
    });

    const profile = JSON.parse(await readFile(profileOutputPath, "utf8")) as {
      deploymentId?: string;
    };
    expect(profile.deploymentId).toMatch(/^eve_[a-f0-9]{32}$/);
    expect(await runEntry(appRoot, outputDir, DRIVER)).toEqual({
      exports: ["EveSession", "default", "startAgain"],
      auditReadyAtImport: false,
      auditReadyAtFirstResponse: true,
      session: "platform-export",
      health: 200,
      info: 401,
      notes: 202,
      label: "Alice's archive",
      savedBeforeWork: false,
      savedAfterWork: true,
      secondStart:
        "start() from eve:app was already called. Keep the app from the first call and pass it to the code that serves requests.",
      loggedCause: "node twin",
    });
    await expect(startProductionServer(appRoot)).rejects.toThrow(
      "This build has a platform entry and no server of its own. Run it with the platform's runtime instead of eve start.",
    );
  });

  it("publishes into the platform's own output directory when building on Vercel", async () => {
    vi.stubEnv("VERCEL", "1");
    const { appRoot } = await createAppRoot("eve-build-entry-vercel-", { files: AGENT_FILES });
    const workerOutput = join(appRoot, "dist", "worker");

    const outputDir = await buildWithPlatform(
      appRoot,
      '{ entry: "platform/entry.mjs", outputDirectory: "dist/worker" }',
    );

    expect(outputDir).toBe(workerOutput);
    expect(JSON.parse(await readFile(join(outputDir, "nitro.json"), "utf8"))).toMatchObject({
      preset: "standard",
    });
    expect(existsSync(join(appRoot, ".vercel", "output"))).toBe(false);
  });

  it("resolves the runtime-env web twins when the platform's conditions omit node", async () => {
    const { appRoot } = await createAppRoot("eve-build-entry-conditions-", { files: AGENT_FILES });

    const outputDir = await buildWithPlatform(
      appRoot,
      '{ entry: "platform/entry.mjs", conditions: ["worker", "browser"] }',
    );

    expect(
      await runEntry(
        appRoot,
        outputDir,
        `import { AsyncLocalStorage } from "node:async_hooks";
globalThis.AsyncLocalStorage = AsyncLocalStorage;
${DRIVER}`,
      ),
    ).toMatchObject({
      health: 200,
      info: 401,
      notes: 202,
      label: "Alice's archive",
      savedAfterWork: true,
      loggedCause: "web twin",
    });
  });

  it("builds an engine's entry beside a platform entry, and both share the one module that calls start()", async () => {
    const { appRoot } = await createAppRoot("eve-build-engine-entry-", { files: AGENT_FILES });
    const outputDir = await buildWithPlatform(appRoot, '{ entry: "platform/served-entry.mjs" }', {
      durable: WORKER_ENGINE,
    });

    expect(
      await runEntry(
        appRoot,
        outputDir,
        `const served = await import(process.env.ENTRY_URL);
const worker = await import(process.env.WORKER_URL);
const health = (url) => new Request(new URL("/eve/v1/health", url));
const fromServed = await served.default.fetch(health("http://localhost"));
const fromWorker = await worker.handle(health("http://localhost"));
console.log("RESULT " + JSON.stringify({
  served: fromServed.status,
  worker: fromWorker.status,
  appLoads: globalThis.platformAppLoads,
}));
process.exit(0);`,
      ),
    ).toEqual({ served: 200, worker: 200, appLoads: 1 });
  });

  it("builds an engine's entry beside eve's Node server without starting the server", async () => {
    const { appRoot } = await createAppRoot("eve-build-engine-entry-node-", { files: AGENT_FILES });
    const outputDir = await buildWithPlatform(appRoot, "{}", { durable: WORKER_ENGINE });

    expect(JSON.parse(await readFile(join(outputDir, "nitro.json"), "utf8"))).toMatchObject({
      preset: "node-server",
    });
    expect(await runEntry(appRoot, outputDir, HEALTH_FROM_WORKER)).toEqual({
      health: 200,
      appLoads: 1,
      listening: false,
    });
  });

  it("refuses to serve a build without node on a runtime with no AsyncLocalStorage", async () => {
    const { appRoot } = await createAppRoot("eve-build-entry-no-als-", { files: AGENT_FILES });
    const outputDir = await buildWithPlatform(
      appRoot,
      '{ entry: "platform/entry.mjs", conditions: ["worker", "browser"] }',
    );

    expect(
      await runEntry(
        appRoot,
        outputDir,
        `const entry = await import(process.env.ENTRY_URL);
const outcome = await entry.default
  .fetch(new Request("http://localhost/eve/v1/health"))
  .then((response) => "served " + response.status, (error) => error.message);
console.log("RESULT " + JSON.stringify(outcome));
process.exit(0);`,
      ),
    ).toMatch(/^start\(\) from eve:app needs AsyncLocalStorage to serve requests\./);
  });

  it("refuses to start an app whose entry did not import eve:instrumentation first", async () => {
    const { appRoot } = await createAppRoot("eve-build-entry-bare-", { files: AGENT_FILES });
    const outputDir = await buildWithPlatform(appRoot, '{ entry: "platform/bare-entry.mjs" }');

    expect(
      await runEntry(
        appRoot,
        outputDir,
        `const entry = await import(process.env.ENTRY_URL);
const outcome = await entry.default
  .fetch(new Request("http://localhost/eve/v1/health"))
  .then((response) => "served " + response.status, (error) => error.message);
console.log("RESULT " + JSON.stringify(outcome));
process.exit(0);`,
      ),
    ).toBe(
      "start() from eve:app ran before eve:instrumentation was imported. Import eve:instrumentation first in your entry, before eve:app.",
    );
  });

  it("stops at an authored schedule even when the platform has triggers, without running them", async () => {
    const { appRoot } = await createAppRoot("eve-build-entry-schedule-", {
      files: {
        ...AGENT_FILES,
        "agent/schedules/digest.md": '---\ncron: "0 9 * * *"\n---\nSend Alice her daily digest.\n',
      },
    });

    await expect(buildWithPlatform(appRoot, '{ entry: "platform/entry.mjs" }')).rejects.toThrow(
      'Authored schedules aren\'t supported with `Build.entry` yet: schedule "digest" in "schedules/digest.md". Remove the schedule or build without `build.entry`. Dynamic schedules through the platform\'s `Triggers` are supported.',
    );
  });
});
