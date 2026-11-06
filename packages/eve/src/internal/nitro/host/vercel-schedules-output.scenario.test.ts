import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildApplication } from "#internal/nitro/host.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();
const CRON_ROUTE = new RegExp(`^${EVE_ROUTE_PREFIX}/cron/`);

interface VercelOutputConfig {
  readonly crons?: readonly { readonly path: string; readonly schedule: string }[];
  readonly routes: readonly { readonly dest?: string; readonly src?: string }[];
  readonly schedules?: Record<string, Record<string, unknown>>;
}

function agentFiles(experimental: string | undefined): Record<string, string> {
  return {
    "agent/agent.ts": `import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4-mini"${
      experimental === undefined ? "" : `, experimental: ${experimental}`
    } });\n`,
    "agent/instructions.md": "Send a digest.\n",
    "agent/schedules/digest.md": '---\ncron: "0 9 * * *"\n---\nSend the daily digest.\n',
  };
}

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
  it("delivers schedules with Vercel Cron Jobs by default", async () => {
    vi.stubEnv("NITRO_VERCEL_SCHEDULES", "private");
    const config = await readOutputConfig(await buildForVercel(agentFiles(undefined)));

    expect(config.schedules).toBeUndefined();
    expect(config.crons).toEqual([
      { path: expect.stringMatching(CRON_ROUTE), schedule: "0 9 * * *" },
    ]);
  });

  it("delivers schedules through a private Vercel Schedules function", async () => {
    const outputDir = await buildForVercel(agentFiles('{ schedules: { vercel: "private" } }'));
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

  it("delivers schedules to eve's cron route in public mode", async () => {
    const config = await readOutputConfig(
      await buildForVercel(agentFiles('{ schedules: { vercel: "public" } }')),
    );

    expect(config.crons ?? []).toEqual([]);
    expect(Object.values(config.schedules ?? {})).toEqual([
      {
        schedule: "0 9 * * *",
        path: expect.stringMatching(CRON_ROUTE),
        requestMethod: "GET",
      },
    ]);
  });

  it("rejects Vercel Schedules for Vercel service builds", async () => {
    await expect(
      buildForVercel({
        ...agentFiles('{ schedules: { vercel: "private" } }'),
        "vercel.json": JSON.stringify({
          experimentalServices: {
            eve: { entrypoint: ".", framework: "eve", routePrefix: "/_eve_internal/eve" },
            web: { entrypoint: ".", framework: "nuxtjs", routePrefix: "/" },
          },
        }),
      }),
    ).rejects.toThrow('"experimental.schedules.vercel" is not supported yet');
  });
});
