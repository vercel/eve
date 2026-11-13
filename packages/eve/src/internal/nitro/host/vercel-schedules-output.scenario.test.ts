import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildApplication } from "#internal/nitro/host.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

interface VercelOutputConfig {
  readonly crons?: readonly { readonly path: string; readonly schedule: string }[];
  readonly routes: readonly { readonly dest?: string }[];
  readonly schedules?: Record<string, Record<string, unknown>>;
}

const AGENT_FILES = {
  "agent/agent.ts": `import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4-mini" });\n`,
  "agent/instructions.md": "Send a digest.\n",
  "agent/schedules/digest.md": '---\ncron: "0 9 * * *"\n---\nSend the daily digest.\n',
};

async function buildForVercel(files: Record<string, string>): Promise<string> {
  const { appRoot } = await createAppRoot("eve-vercel-schedules-", {
    packageName: "schedules-agent",
    files,
  });
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
  return await buildApplication(appRoot, { skipSandboxPrewarm: true });
}

async function readOutputConfig(outputDir: string): Promise<VercelOutputConfig> {
  return JSON.parse(await readFile(join(outputDir, "config.json"), "utf8")) as VercelOutputConfig;
}

describe("schedule host delivery", () => {
  it("boots a Node build and fires its timezone task once at the configured local time", async () => {
    vi.stubEnv("VERCEL", "");
    const { appRoot } = await createAppRoot("eve-node-timezone-", {
      packageName: "timezone-agent",
      files: {
        ...AGENT_FILES,
        "agent/schedules/pacific.ts": `import { defineSchedule } from "eve/schedules";
export default defineSchedule({ cron: "0 13 * * *", timezone: "America/Los_Angeles", run() {
  globalThis.__timezoneRuns = (globalThis.__timezoneRuns ?? 0) + 1;
} });`,
      },
    });
    const outputDir = await buildApplication(appRoot, { skipSandboxPrewarm: true });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
const realSetTimeout = globalThis.setTimeout;
mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-07-15T19:59:59Z") });
await import(${JSON.stringify(pathToFileURL(join(outputDir, "server/index.mjs")).href)});
mock.timers.tick(999);
await setImmediate();
if (globalThis.__timezoneRuns) throw new Error("Schedule fired early");
mock.timers.tick(1);
for (let i = 0; i < 500 && !globalThis.__timezoneRuns; i++) {
  await new Promise((resolve) => realSetTimeout(resolve, 10));
}
if (globalThis.__timezoneRuns !== 1) throw new Error("Expected one timezone run, got " + globalThis.__timezoneRuns);
console.log("timezone-task-fired-once");
process.exit(0);
`,
      ],
      {
        env: { ...process.env, PORT: "0", TZ: "UTC" },
        timeout: 15_000,
      },
    );
    expect(stdout).toContain("timezone-task-fired-once");
  });

  it("runs schedules through a private Vercel Schedules function", async () => {
    vi.stubEnv("NITRO_VERCEL_SCHEDULES", "public");
    const outputDir = await buildForVercel({
      ...AGENT_FILES,
      "agent/schedules/pacific.md":
        '---\ncron: "0 9 * * *"\ntimezone: America/Los_Angeles\n---\nSend the Pacific digest.\n',
      "agent/schedules/europe.ts": `import { defineSchedule } from "eve/schedules";
export default defineSchedule({ cron: "0 9 * * *", timezone: "Europe/London", run() {} });`,
    });
    const config = await readOutputConfig(outputDir);
    const functionConfig = JSON.parse(
      await readFile(
        join(outputDir, "functions", "_vercel", "tasks.func", ".vc-config.json"),
        "utf8",
      ),
    ) as { readonly experimentalTriggers?: readonly unknown[] };

    expect(config.crons ?? []).toEqual([]);
    expect(config.schedules).toEqual({
      "eve.digest": { schedule: "0 9 * * *", function: "_vercel/tasks" },
      "eve.pacific": {
        schedule: "0 9 * * *",
        timezone: "America/Los_Angeles",
        function: "_vercel/tasks",
      },
      "eve.europe": { schedule: "0 9 * * *", timezone: "Europe/London", function: "_vercel/tasks" },
    });
    expect(functionConfig.experimentalTriggers).toEqual([{ type: "schedule/v1beta" }]);
    expect(config.routes).not.toContainEqual(expect.objectContaining({ dest: "/_vercel/tasks" }));
  });

  it("keeps the private Vercel Schedules function in Vercel service builds", async () => {
    const outputDir = await buildForVercel({
      ...AGENT_FILES,
      "agent/schedules/digest.md":
        '---\ncron: "0 9 * * *"\ntimezone: America/Los_Angeles\n---\nSend the daily digest.\n',
      "vercel.json": JSON.stringify({
        experimentalServices: {
          eve: { entrypoint: ".", framework: "eve", routePrefix: "/_eve_internal/eve" },
          web: { entrypoint: ".", framework: "nuxtjs", routePrefix: "/" },
        },
      }),
    });
    const config = await readOutputConfig(outputDir);

    expect(config.crons ?? []).toEqual([]);
    expect(config.schedules).toEqual({
      "eve.schedules-agent.digest": {
        schedule: "0 9 * * *",
        timezone: "America/Los_Angeles",
        function: "_vercel/tasks",
      },
    });
    await expect(
      readFile(join(outputDir, "functions", "_vercel", "tasks.func", ".vc-config.json"), "utf8"),
    ).resolves.toContain("schedule/v1beta");
  });
});
