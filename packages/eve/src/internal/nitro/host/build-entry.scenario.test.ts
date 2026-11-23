import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication } from "#internal/nitro/host.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { definePlatform } from "#platform/declaration.js";
import { defaultPlatform } from "#platform/default.js";
import type { Build } from "#platform/entities.js";

const execFileAsync = promisify(execFile);
const createAppRoot = useTemporaryAppRoots();

const AGENT_FILES = {
  "agent/agent.mjs":
    'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4-mini" });',
  "agent/instructions.md": "Help Alice plan her week.\n",
  "agent/channels/notes.mjs": [
    'import { defineChannel, POST } from "eve/channels";',
    'import { setTimeout } from "node:timers/promises";',
    "export default defineChannel({",
    "  routes: [",
    '    POST("/notes", (_request, { waitUntil }) => {',
    "      waitUntil(setTimeout(20).then(() => { globalThis.noteSaved = true; }));",
    '      return new Response("accepted", { status: 202 });',
    "    }),",
    "  ],",
    "});",
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
const work = [];
const send = (path, init) =>
  entry.default.fetch(new Request("http://localhost" + path, init), {}, { waitUntil: (promise) => work.push(promise) });
const health = await send("/eve/v1/health");
const info = await send("/eve/v1/info");
const notes = await send("/notes", { method: "POST" });
const savedBeforeWork = globalThis.noteSaved === true;
await Promise.all(work);
const secondStart = await entry.startAgain().then(() => "started", (error) => error.message);
console.log("RESULT " + JSON.stringify({
  exports: Object.keys(entry).sort(),
  session: new entry.EveSession().kind,
  health: health.status,
  info: info.status,
  notes: notes.status,
  savedBeforeWork,
  savedAfterWork: globalThis.noteSaved === true,
  secondStart,
}));
process.exit(0);
`;

async function buildWithPlatform(
  appRoot: string,
  build: Build,
  options: { readonly profileOutputPath?: string } = {},
): Promise<string> {
  return await buildApplication(appRoot, {
    ...options,
    platform: definePlatform({ deployment: defaultPlatform.deployment, build }),
    skipSandboxPrewarm: true,
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("a build with a platform entry", () => {
  it("bundles the entry as the server and serves eve through start() from eve:app", async () => {
    vi.stubEnv("NITRO_PRESET", "node-server");
    vi.stubEnv("VERCEL", "");
    const { appRoot } = await createAppRoot("eve-build-entry-", { files: AGENT_FILES });
    const profileOutputPath = join(appRoot, "build-profile.json");

    const outputDir = await buildWithPlatform(
      appRoot,
      { entry: "platform/entry.mjs" },
      { profileOutputPath },
    );

    const profile = JSON.parse(await readFile(profileOutputPath, "utf8")) as {
      deploymentId?: string;
    };
    expect(profile.deploymentId).toMatch(/^eve_[a-f0-9]{32}$/);
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", DRIVER],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          ENTRY_URL: pathToFileURL(join(outputDir, "server", "index.mjs")).href,
          NITRO_PRESET: "",
        },
        timeout: 60_000,
      },
    );
    const result = stdout.split("\n").find((line) => line.startsWith("RESULT "));
    expect(JSON.parse(result!.slice("RESULT ".length))).toEqual({
      exports: ["EveSession", "default", "startAgain"],
      session: "platform-export",
      health: 200,
      info: 401,
      notes: 202,
      savedBeforeWork: false,
      savedAfterWork: true,
      secondStart:
        "start() from eve:app was already called. Keep the app from the first call and pass it to the code that serves requests.",
    });
  });
});
