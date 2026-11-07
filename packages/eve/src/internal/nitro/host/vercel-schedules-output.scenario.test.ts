import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildApplication } from "#internal/nitro/host.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
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

describe("Vercel schedule delivery", () => {
  it("runs schedules through a private Vercel Schedules function", async () => {
    vi.stubEnv("NITRO_VERCEL_SCHEDULES", "public");
    const outputDir = await buildForVercel(AGENT_FILES);
    const config = await readOutputConfig(outputDir);
    const functionConfig = JSON.parse(
      await readFile(
        join(outputDir, "functions", "_vercel", "tasks.func", ".vc-config.json"),
        "utf8",
      ),
    ) as { readonly experimentalTriggers?: readonly unknown[] };

    expect(config.crons ?? []).toEqual([]);
    expect(Object.values(config.schedules ?? {})).toEqual([
      { schedule: "0 9 * * *", function: "_vercel/tasks" },
    ]);
    expect(functionConfig.experimentalTriggers).toEqual([{ type: "schedule/v1beta" }]);
    expect(config.routes).not.toContainEqual(expect.objectContaining({ dest: "/_vercel/tasks" }));
  });

  // Vercel rejects `schedules` in a service's Build Output.
  it("keeps Vercel Cron Jobs for Vercel service builds", async () => {
    const config = await readOutputConfig(
      await buildForVercel({
        ...AGENT_FILES,
        "vercel.json": JSON.stringify({
          experimentalServices: {
            eve: { entrypoint: ".", framework: "eve", routePrefix: "/_eve_internal/eve" },
            web: { entrypoint: ".", framework: "nuxtjs", routePrefix: "/" },
          },
        }),
      }),
    );

    expect(config.schedules).toBeUndefined();
    expect(config.crons).toEqual([
      {
        path: expect.stringMatching(new RegExp(`^${EVE_ROUTE_PREFIX}/cron/`)),
        schedule: "0 9 * * *",
      },
    ]);
  });
});
