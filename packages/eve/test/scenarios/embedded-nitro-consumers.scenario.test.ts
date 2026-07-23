import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { access, cp, glob, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import {
  DEVELOPMENT_CONTROL_TOKEN_HEADER,
  readDevelopmentControlToken,
} from "../../src/internal/nitro/dev-control-auth.js";
import {
  createEveDevDispatchSchedulePath,
  EVE_HEALTH_ROUTE_PATH,
} from "../../src/protocol/routes.js";

const scenarioApp = useScenarioApp();
const temporaryRoots: string[] = [];
const runningProcesses: RunningProcess[] = [];

const PROCESS_TIMEOUT_MS = 180_000;
const SCENARIO_TIMEOUT_MS = 420_000;

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface RunningProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly result: Promise<ProcessResult>;
  stderr(): string;
  stdout(): string;
  stop(): Promise<void>;
}

const PLAIN_NITRO_DESCRIPTOR: ScenarioAppDescriptor = {
  name: "embedded-nitro-plain",
  installDependencies: true,
  dependencies: {
    nitro: "3.0.260610-beta",
    vite: "8.0.0",
  },
  files: {
    "agent/agent.ts": 'export default { model: "openai/gpt-5.4-mini" };\n',
    "agent/instructions.md": "Reply precisely.\n",
    "agent/skills/portable/SKILL.md": [
      "---",
      'name: "portable"',
      'description: "A packaged portability marker."',
      "---",
      "",
      "This resource must survive without the source tree.",
      "",
    ].join("\n"),
    "agent/schedules/cadence.ts": scheduleSource(),
    "agent/channels/embedded.ts": channelSource("eve-v1", false),
    "routes/index.ts": [
      'import { defineHandler } from "nitro";',
      "",
      'export default defineHandler(() => new Response("host-root"));',
      "",
    ].join("\n"),
    "vite.config.ts": [
      'import { defineConfig } from "vite";',
      'import { nitro } from "nitro/vite";',
      'import { eveNitro } from "eve/nitro";',
      "",
      "export default defineConfig(({ command }) => ({",
      "  plugins: [",
      "    eveNitro(),",
      '    ...nitro({ serverDir: ".", preset: command === "serve" ? "nitro-dev" : "node-server" }),',
      "  ],",
      "}));",
      "",
    ].join("\n"),
  },
};

const TANSTACK_START_DESCRIPTOR: ScenarioAppDescriptor = {
  name: "embedded-nitro-tanstack-start",
  installDependencies: true,
  dependencies: {
    "@tanstack/react-router": "1.170.18",
    "@tanstack/react-start": "1.168.32",
    "@vitejs/plugin-react": "6.0.3",
    nitro: "3.0.260610-beta",
    react: "19.2.8",
    "react-dom": "19.2.8",
    vite: "8.1.5",
  },
  files: {
    "agent/agent.ts": 'export default { model: "openai/gpt-5.4-mini" };\n',
    "agent/instructions.md": "Reply precisely.\n",
    "agent/channels/embedded.ts": channelSource("tanstack-eve-v1", false),
    "agent/schedules/cadence.ts": scheduleSource(),
    "src/router.tsx": tanStackRouterSource(),
    "src/routes/__root.tsx": [
      'import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";',
      "",
      "export const Route = createRootRoute({",
      '  head: () => ({ meta: [{ title: "TanStack host" }] }),',
      "  component: RootComponent,",
      "});",
      "",
      "function RootComponent() {",
      "  return (",
      '    <html lang="en">',
      "      <head><HeadContent /></head>",
      "      <body><Outlet /><Scripts /></body>",
      "    </html>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "src/routes/index.tsx": [
      'import { createFileRoute } from "@tanstack/react-router";',
      'import { createServerFn } from "@tanstack/react-start";',
      "",
      "const getServerMarker = createServerFn().handler(async () =>",
      '  "tanstack-server-function",',
      ");",
      "",
      'export const Route = createFileRoute("/")({',
      "  loader: () => getServerMarker(),",
      "  component: Home,",
      "});",
      "",
      "function Home() {",
      "  const serverMarker = Route.useLoaderData();",
      "  return <main>tanstack-host-root:{serverMarker}</main>;",
      "}",
      "",
    ].join("\n"),
    "src/routes/eve-like.tsx": [
      'import { createFileRoute } from "@tanstack/react-router";',
      "",
      'export const Route = createFileRoute("/eve-like")({',
      "  component: () => <main>tanstack-similar-route</main>,",
      "});",
      "",
    ].join("\n"),
    "vite.config.ts": tanStackViteConfigSource(),
  },
};

const TANSTACK_START_BASES_DESCRIPTOR: ScenarioAppDescriptor = {
  ...TANSTACK_START_DESCRIPTOR,
  name: "embedded-nitro-tanstack-start-bases",
  files: {
    ...TANSTACK_START_DESCRIPTOR.files,
    "agent/channels/embedded.ts": httpChannelSource("tanstack-bases-eve"),
    "src/router.tsx": tanStackRouterSource("/start"),
    "vite.config.ts": tanStackViteConfigSource("/start/"),
  },
};

const ASTRO_DESCRIPTOR: ScenarioAppDescriptor = {
  name: "embedded-nitro-astro",
  installDependencies: true,
  dependencies: {
    astro: "7.1.3",
    nitro: "3.0.260610-beta",
    vite: "8.1.5",
  },
  files: {
    "agent/agent.ts": 'export default { model: "openai/gpt-5.4-mini" };\n',
    "agent/instructions.md": "Reply precisely.\n",
    "agent/channels/embedded.ts": channelSource("astro-eve-v1", false),
    "agent/schedules/cadence.ts": scheduleSource(),
    "src/pages/index.astro": [
      "---",
      'const title = "Astro host";',
      "---",
      "",
      '<html lang="en">',
      "  <head><title>{title}</title></head>",
      "  <body><main>astro-host-root</main></body>",
      "</html>",
      "",
    ].join("\n"),
    "astro.config.mjs": [
      'import { defineConfig } from "astro/config";',
      'import { eveNitroAstro } from "eve/nitro";',
      "",
      "export default defineConfig({",
      '  output: "server",',
      "  adapter: eveNitroAstro(),",
      "});",
      "",
    ].join("\n"),
  },
};

function scheduleSource(): string {
  return [
    'import { writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'import { defineSchedule } from "eve/schedules";',
    "",
    "export default defineSchedule({",
    '  cron: "* * * * *",',
    "  async run() {",
    '    await writeFile(join(process.cwd(), "eve-schedule-fired.txt"), "cadence-ok\\n");',
    "  },",
    "});",
    "",
  ].join("\n");
}

function channelSource(marker: string, includeAddedRoute: boolean): string {
  return [
    'import { writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'import { defineChannel, GET, WS } from "eve/channels";',
    "",
    "export default defineChannel({",
    "  routes: [",
    `    GET("/eve-marker", () => new Response(${JSON.stringify(marker)})),`,
    ...(includeAddedRoute ? ['    GET("/eve-added", () => new Response("topology-ok")),'] : []),
    '    GET("/eve-binary", () => new Response(Uint8Array.from([0, 1, 2, 255]))),',
    '    GET("/eve-stream", () => {',
    "      let timer;",
    "      const encoder = new TextEncoder();",
    "      return new Response(",
    "        new ReadableStream({",
    "          start(controller) {",
    '            controller.enqueue(encoder.encode("first\\n"));',
    "            timer = setInterval(() => {",
    '              controller.enqueue(encoder.encode("next\\n"));',
    "            }, 50);",
    "          },",
    "          cancel() {",
    "            clearInterval(timer);",
    "            void writeFile(",
    '              join(process.cwd(), "eve-stream-cancelled.txt"),',
    '              "cancelled-ok\\n",',
    "            );",
    "          },",
    "        }),",
    '        { headers: { "content-type": "text/plain" } },',
    "      );",
    "    }),",
    '    WS("/eve-socket", async () => ({',
    "      message(peer, message) {",
    "        peer.send(`echo:${message.text()}`);",
    "      },",
    "    })),",
    "  ],",
    "});",
    "",
  ].join("\n");
}

function httpChannelSource(marker: string, includeAddedRoute = false): string {
  return [
    'import { defineChannel, GET } from "eve/channels";',
    "",
    "export default defineChannel({",
    "  routes: [",
    `    GET("/eve-marker", () => new Response(${JSON.stringify(marker)})),`,
    ...(includeAddedRoute ? ['    GET("/eve-added", () => new Response("topology-ok")),'] : []),
    "  ],",
    "});",
    "",
  ].join("\n");
}

function tanStackRouterSource(basepath?: string): string {
  return [
    'import { createRouter } from "@tanstack/react-router";',
    'import { routeTree } from "./routeTree.gen";',
    "",
    "export function getRouter() {",
    `  return createRouter({${basepath === undefined ? "" : ` basepath: ${JSON.stringify(basepath)},`} routeTree, scrollRestoration: true });`,
    "}",
    "",
    'declare module "@tanstack/react-router" {',
    "  interface Register {",
    "    router: ReturnType<typeof getRouter>;",
    "  }",
    "}",
    "",
  ].join("\n");
}

function tanStackViteConfigSource(base?: string): string {
  return [
    'import { tanstackStart } from "@tanstack/react-start/plugin/vite";',
    'import react from "@vitejs/plugin-react";',
    'import { defineConfig } from "vite";',
    'import { nitro } from "nitro/vite";',
    'import { eveNitro } from "eve/nitro";',
    "",
    "export default defineConfig(({ command }) => ({",
    ...(base === undefined ? [] : [`  base: ${JSON.stringify(base)},`]),
    "  plugins: [",
    "    tanstackStart(),",
    "    eveNitro(),",
    '    ...nitro({ preset: command === "serve" ? "nitro-dev" : "node-server" }),',
    "    react(),",
    "  ],",
    "}));",
    "",
  ].join("\n");
}

function startProcess(input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): RunningProcess {
  const child = spawn(process.execPath, [...input.args], {
    cwd: input.cwd,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = new Promise<ProcessResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          [
            `Process timed out: node ${input.args.join(" ")}`,
            `stdout:\n${stdout}`,
            `stderr:\n${stderr}`,
          ].join("\n\n"),
        ),
      );
    }, PROCESS_TIMEOUT_MS);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr, stdout });
    });
  });

  const processHandle: RunningProcess = {
    child,
    result,
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        await result.catch(() => undefined);
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
      await result.catch(() => undefined);
    },
  };
  runningProcesses.push(processHandle);
  return processHandle;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function waitForResponse(
  url: string,
  predicate: (response: Response, body: string) => boolean,
  processHandle: RunningProcess,
): Promise<{ readonly body: string; readonly response: Response }> {
  const startedAt = Date.now();
  let lastFailure = "no response";
  while (Date.now() - startedAt < 45_000) {
    if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
      const result = await processHandle.result;
      throw new Error(
        [
          `Server exited before ${url} became ready (code ${String(result.code)}, signal ${String(result.signal)}).`,
          `stdout:\n${result.stdout}`,
          `stderr:\n${result.stderr}`,
        ].join("\n\n"),
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      if (predicate(response, body)) {
        return { body, response };
      }
      lastFailure = `status ${String(response.status)}, body ${JSON.stringify(body)}`;
    } catch (error) {
      lastFailure = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    [
      `Timed out waiting for ${url}: ${lastFailure}`,
      `stdout:\n${processHandle.stdout()}`,
      `stderr:\n${processHandle.stderr()}`,
    ].join("\n\n"),
  );
}

async function waitForFile(path: string): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 75_000) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function findFile(root: string, fileName: string): Promise<string | undefined> {
  for await (const path of glob(join(root, "**", fileName))) {
    return path;
  }
  return undefined;
}

async function expectWebSocketEcho(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out waiting for a WebSocket echo from ${url}.`));
    }, 10_000);
    socket.addEventListener("open", () => socket.send("ping"));
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      try {
        expect(event.data).toBe("echo:ping");
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        socket.close();
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket connection failed for ${url}.`));
    });
  });
}

async function expectFullChannelParity(serverUrl: string, processRoot: string): Promise<void> {
  const binaryBuffer = await fetch(`${serverUrl}/eve-binary`).then((response) =>
    response.arrayBuffer(),
  );
  expect([...new Uint8Array(binaryBuffer)]).toEqual([0, 1, 2, 255]);

  const streamResponse = await fetch(`${serverUrl}/eve-stream`);
  const reader = streamResponse.body?.getReader();
  const firstChunk = await reader?.read();
  expect(new TextDecoder().decode(firstChunk?.value)).toBe("first\n");
  await reader?.cancel();
  await expect(waitForFile(join(processRoot, "eve-stream-cancelled.txt"))).resolves.toBe(
    "cancelled-ok\n",
  );

  await expectWebSocketEcho(serverUrl.replace(/^http/u, "ws") + "/eve-socket");
}

function createProductionEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const { NODE_ENV: _nodeEnvironment, TEST: _test, ...environment } = process.env;
  return {
    ...environment,
    ...overrides,
    NODE_ENV: "production",
  };
}

afterEach(async () => {
  await Promise.all(runningProcesses.splice(0).map((processHandle) => processHandle.stop()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("embedded eve Nitro consumers", () => {
  it(
    "runs plain Nitro/Vite in development and from a moved production artifact",
    async () => {
      const app = await scenarioApp(PLAIN_NITRO_DESCRIPTOR);
      const port = await reservePort();
      const serverUrl = `http://127.0.0.1:${String(port)}`;
      const viteBin = join(app.appRoot, "node_modules", "vite", "bin", "vite.js");
      const dev = startProcess({
        args: [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        cwd: app.appRoot,
      });

      await waitForResponse(`${serverUrl}/`, (_response, body) => body === "host-root", dev);
      await waitForResponse(
        `${serverUrl}/eve-marker`,
        (response, body) => response.status === 200 && body === "eve-v1",
        dev,
      );
      const health = await fetch(`${serverUrl}${EVE_HEALTH_ROUTE_PATH}`);
      expect(health.status).toBe(200);

      const schedulePath = createEveDevDispatchSchedulePath("cadence");
      const unauthorizedSchedule = await fetch(`${serverUrl}${schedulePath}`, {
        headers: { origin: "https://example.test" },
        method: "POST",
      });
      expect(unauthorizedSchedule.status).toBe(401);
      const developmentControlToken = await readDevelopmentControlToken({
        appRoot: app.appRoot,
        serverUrl,
      });
      expect(developmentControlToken).toBeDefined();
      const authorizedSchedule = await fetch(`${serverUrl}${schedulePath}`, {
        headers: { [DEVELOPMENT_CONTROL_TOKEN_HEADER]: developmentControlToken! },
        method: "POST",
      });
      expect(authorizedSchedule.status).toBe(200);

      const channelPath = join(app.appRoot, "agent", "channels", "embedded.ts");
      await writeFile(channelPath, channelSource("eve-v2", true));
      await waitForResponse(
        `${serverUrl}/eve-added`,
        (response, body) => response.status === 200 && body === "topology-ok",
        dev,
      );
      await expect(fetch(`${serverUrl}/`).then((response) => response.text())).resolves.toBe(
        "host-root",
      );

      await writeFile(channelPath, "export default { this is not valid TypeScript\n");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await expect(
        fetch(`${serverUrl}/eve-marker`).then((response) => response.text()),
      ).resolves.toBe("eve-v2");
      await writeFile(channelPath, channelSource("eve-v3", true));
      await waitForResponse(
        `${serverUrl}/eve-marker`,
        (response, body) => response.status === 200 && body === "eve-v3",
        dev,
      );
      await expect(fetch(`${serverUrl}/`).then((response) => response.text())).resolves.toBe(
        "host-root",
      );
      await writeFile(channelPath, channelSource("eve-v4", false));
      await waitForResponse(
        `${serverUrl}/eve-marker`,
        (response, body) => response.status === 200 && body === "eve-v4",
        dev,
      );
      await waitForResponse(`${serverUrl}/eve-added`, (response) => response.status === 404, dev);
      await expect(fetch(`${serverUrl}/`).then((response) => response.text())).resolves.toBe(
        "host-root",
      );
      await dev.stop();

      await runPnpmCommand({
        args: ["exec", "vite", "build"],
        cwd: app.appRoot,
        env: createProductionEnvironment(),
      });
      const portabilityRoot = await mkdtemp(join(tmpdir(), "eve-embedded-portable-"));
      temporaryRoots.push(portabilityRoot);
      const movedOutput = join(portabilityRoot, "artifact");
      await cp(join(app.appRoot, ".output"), movedOutput, { recursive: true });
      await rm(app.appRoot, { force: true, recursive: true });

      const productionPort = await reservePort();
      const productionUrl = `http://127.0.0.1:${String(productionPort)}`;
      const productionEnv = createProductionEnvironment({
        HOST: "127.0.0.1",
        NITRO_PORT: String(productionPort),
      });
      const production = startProcess({
        args: [join(movedOutput, "server", "index.mjs")],
        cwd: movedOutput,
        env: productionEnv,
      });

      await waitForResponse(
        `${productionUrl}/`,
        (response, body) => response.status === 200 && body === "host-root",
        production,
      );
      await expect(
        fetch(`${productionUrl}/eve-marker`).then((response) => response.text()),
      ).resolves.toBe("eve-v4");
      await expect(fetch(`${productionUrl}/eve-added`).then((r) => r.status)).resolves.toBe(404);
      await expect(
        fetch(`${productionUrl}${EVE_HEALTH_ROUTE_PATH}`).then((r) => r.status),
      ).resolves.toBe(200);

      const workflow = await fetch(`${productionUrl}/.well-known/workflow/v1/flow`, {
        method: "POST",
      });
      expect(workflow.status).not.toBe(404);

      await expectFullChannelParity(productionUrl, movedOutput);
      await expect(waitForFile(join(movedOutput, "eve-schedule-fired.txt"))).resolves.toBe(
        "cadence-ok\n",
      );

      const packagedSkill = await findFile(join(movedOutput, ".eve"), "SKILL.md");
      expect(packagedSkill).toBeDefined();
      if (packagedSkill !== undefined) {
        await expect(access(packagedSkill)).resolves.toBeUndefined();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "runs TanStack Start in development and production",
    async () => {
      const app = await scenarioApp(TANSTACK_START_DESCRIPTOR);
      const port = await reservePort();
      const serverUrl = `http://127.0.0.1:${String(port)}`;
      const viteBin = join(app.appRoot, "node_modules", "vite", "bin", "vite.js");
      const dev = startProcess({
        args: [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        cwd: app.appRoot,
      });

      await waitForResponse(
        `${serverUrl}/`,
        (response, body) =>
          response.status === 200 &&
          body.includes("tanstack-host-root") &&
          body.includes("tanstack-server-function"),
        dev,
      );
      await waitForResponse(
        `${serverUrl}/eve-marker`,
        (response, body) => response.status === 200 && body === "tanstack-eve-v1",
        dev,
      );
      await waitForResponse(
        `${serverUrl}/eve-like`,
        (response, body) => response.status === 200 && body.includes("tanstack-similar-route"),
        dev,
      );
      expect(
        (
          await fetch(`${serverUrl}/.well-known/workflow/v1/flow`, {
            method: "POST",
          })
        ).status,
      ).not.toBe(404);

      await writeFile(
        join(app.appRoot, "agent", "channels", "embedded.ts"),
        channelSource("tanstack-eve-v2", false),
      );
      await waitForResponse(
        `${serverUrl}/eve-marker`,
        (response, body) => response.status === 200 && body === "tanstack-eve-v2",
        dev,
      );
      await expect(fetch(`${serverUrl}/`).then((response) => response.text())).resolves.toContain(
        "tanstack-host-root",
      );
      await dev.stop();

      await runPnpmCommand({
        args: ["exec", "vite", "build"],
        cwd: app.appRoot,
        env: createProductionEnvironment(),
      });
      const portabilityRoot = await mkdtemp(join(tmpdir(), "eve-tanstack-portable-"));
      temporaryRoots.push(portabilityRoot);
      const movedOutput = join(portabilityRoot, "artifact");
      await cp(join(app.appRoot, ".output"), movedOutput, { recursive: true });
      await rm(app.appRoot, { force: true, recursive: true });
      const productionPort = await reservePort();
      const productionUrl = `http://127.0.0.1:${String(productionPort)}`;
      const productionEnv = createProductionEnvironment({
        HOST: "127.0.0.1",
        NITRO_PORT: String(productionPort),
      });
      const production = startProcess({
        args: [join(movedOutput, "server", "index.mjs")],
        cwd: movedOutput,
        env: productionEnv,
      });

      await waitForResponse(
        `${productionUrl}/`,
        (response, body) =>
          response.status === 200 &&
          body.includes("tanstack-host-root") &&
          body.includes("tanstack-server-function"),
        production,
      );
      await expect(
        fetch(`${productionUrl}/eve-marker`).then((response) => response.text()),
      ).resolves.toBe("tanstack-eve-v2");
      await expect(
        fetch(`${productionUrl}${EVE_HEALTH_ROUTE_PATH}`).then((response) => response.status),
      ).resolves.toBe(200);
      await expect(
        fetch(`${productionUrl}/eve-like`).then((response) => response.text()),
      ).resolves.toContain("tanstack-similar-route");
      expect(
        (
          await fetch(`${productionUrl}/.well-known/workflow/v1/flow`, {
            method: "POST",
          })
        ).status,
      ).not.toBe(404);
      await expectFullChannelParity(productionUrl, movedOutput);
      await expect(waitForFile(join(movedOutput, "eve-schedule-fired.txt"))).resolves.toBe(
        "cadence-ok\n",
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps fixed eve routes at the origin root with Vite and Start base paths",
    async () => {
      const app = await scenarioApp(TANSTACK_START_BASES_DESCRIPTOR);
      const port = await reservePort();
      const serverUrl = `http://127.0.0.1:${String(port)}`;
      const viteBin = join(app.appRoot, "node_modules", "vite", "bin", "vite.js");
      const dev = startProcess({
        args: [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        cwd: app.appRoot,
      });

      await waitForResponse(
        `${serverUrl}/start/`,
        (response, body) =>
          response.status === 200 &&
          body.includes("tanstack-host-root") &&
          body.includes("tanstack-server-function"),
        dev,
      );
      await waitForResponse(
        `${serverUrl}/eve-marker`,
        (response, body) => response.status === 200 && body === "tanstack-bases-eve",
        dev,
      );
      await expect(fetch(`${serverUrl}/start/eve-marker`).then((r) => r.status)).resolves.toBe(404);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "runs Astro in development and production",
    async () => {
      const app = await scenarioApp(ASTRO_DESCRIPTOR);
      const port = await reservePort();
      const serverUrl = `http://127.0.0.1:${String(port)}`;
      const astroBin = join(app.appRoot, "node_modules", "astro", "bin", "astro.mjs");
      const dev = startProcess({
        args: [astroBin, "dev", "--host", "127.0.0.1", "--port", String(port)],
        cwd: app.appRoot,
        env: { ...process.env, ASTRO_DEV_BACKGROUND: "0" },
      });

      await waitForResponse(
        `${serverUrl}/`,
        (response, body) => response.status === 200 && body.includes("astro-host-root"),
        dev,
      );
      await waitForResponse(
        `${serverUrl}/eve-marker`,
        (response, body) => response.status === 200 && body === "astro-eve-v1",
        dev,
      );
      expect(
        (
          await fetch(`${serverUrl}/.well-known/workflow/v1/flow`, {
            method: "POST",
          })
        ).status,
      ).not.toBe(404);

      await writeFile(
        join(app.appRoot, "agent", "channels", "embedded.ts"),
        channelSource("astro-eve-v2", true),
      );
      await waitForResponse(
        `${serverUrl}/eve-marker`,
        (response, body) => response.status === 200 && body === "astro-eve-v2",
        dev,
      );
      await waitForResponse(
        `${serverUrl}/eve-added`,
        (response, body) => response.status === 200 && body === "topology-ok",
        dev,
      );
      await expect(fetch(`${serverUrl}/`).then((response) => response.text())).resolves.toContain(
        "astro-host-root",
      );
      await dev.stop();

      await runPnpmCommand({
        args: ["exec", "astro", "build"],
        cwd: app.appRoot,
        env: createProductionEnvironment(),
      });
      const portabilityRoot = await mkdtemp(join(tmpdir(), "eve-astro-portable-"));
      temporaryRoots.push(portabilityRoot);
      const movedOutput = join(portabilityRoot, "artifact");
      await cp(join(app.appRoot, ".output"), movedOutput, { recursive: true });
      await rm(app.appRoot, { force: true, recursive: true });
      const productionPort = await reservePort();
      const productionUrl = `http://127.0.0.1:${String(productionPort)}`;
      const productionEnv = createProductionEnvironment({
        HOST: "127.0.0.1",
        NITRO_PORT: String(productionPort),
      });
      const production = startProcess({
        args: [join(movedOutput, "server", "index.mjs")],
        cwd: movedOutput,
        env: productionEnv,
      });

      await waitForResponse(
        `${productionUrl}/`,
        (response, body) => response.status === 200 && body.includes("astro-host-root"),
        production,
      );
      await expect(
        fetch(`${productionUrl}/eve-marker`).then((response) => response.text()),
      ).resolves.toBe("astro-eve-v2");
      await expect(
        fetch(`${productionUrl}/eve-added`).then((response) => response.text()),
      ).resolves.toBe("topology-ok");
      await expect(
        fetch(`${productionUrl}${EVE_HEALTH_ROUTE_PATH}`).then((response) => response.status),
      ).resolves.toBe(200);
      expect(
        (
          await fetch(`${productionUrl}/.well-known/workflow/v1/flow`, {
            method: "POST",
          })
        ).status,
      ).not.toBe(404);
      await expectFullChannelParity(productionUrl, movedOutput);
      await expect(waitForFile(join(movedOutput, "eve-schedule-fired.txt"))).resolves.toBe(
        "cadence-ok\n",
      );
    },
    SCENARIO_TIMEOUT_MS,
  );
});
