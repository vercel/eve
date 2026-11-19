import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";

const execFileAsync = promisify(execFile);
const SCENARIO_TIMEOUT_MS = 180_000;

const APP = {
  name: "schedule-dry-run",
  installDependencies: true,
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
export default defineAgent({ model: "openai/gpt-5.4" });
`,
    "agent/instructions.md": "You write Atlas's weekly revenue summary.\n",
    "agent/tools/lookup_account.ts": `import { defineTool } from "eve/tools";
export default defineTool({
  description: "Look up a customer account.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  execute: async (input: { id: string }) => input,
});
`,
    "agent/tools/revenue_forecast.ts": `import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
export default defineDynamic((ctx) => {
  const groups = [ctx.session.auth.current?.attributes.groups ?? []].flat();
  if (!groups.includes("finance")) return undefined;
  return defineTool({
    description: "Read the revenue forecast for a quarter.",
    inputSchema: { type: "object", properties: { quarter: { type: "string" } }, required: ["quarter"] },
    execute: async (input: { quarter: string }) => input,
  });
});
`,
    "agent/channels/digest.ts": `import { defineChannel, POST } from "eve/channels";
export default defineChannel({
  routes: [POST("/digest", async () => new Response("ok"))],
  async receive({ message, target, ...send }, { from }) {
    return await from("digest:" + (target as { channelId: string }).channelId).send(message, send);
  },
});
`,
    "agent/schedules/weekly-summary.ts": `import { defineSchedule } from "eve/schedules";
import digest from "../channels/digest";
export default defineSchedule({
  cron: "0 9 * * 1",
  async run({ to, appAuth, waitUntil }) {
    await fetch(process.env.WAREHOUSE_URL + "/v1/accounts?active=true");
    waitUntil(
      to(digest, { channelId: "C0ATLAS01" }).send("Write the weekly revenue summary.", {
        auth: appAuth,
      }),
    );
  },
});
`,
  },
};

describe("eve schedule run --dry-run and eve info --as", () => {
  let app: Awaited<ReturnType<typeof materializeScenarioApp>>;
  let warehouse: Server;
  let warehouseUrl: string;
  const warehouseRequests: string[] = [];

  beforeAll(async () => {
    app = await materializeScenarioApp(APP);
    warehouse = createServer((request, response) => {
      warehouseRequests.push(request.url ?? "");
      response.end("{}");
    });
    await new Promise<void>((resolve) => warehouse.listen(0, "127.0.0.1", resolve));
    warehouseUrl = `http://127.0.0.1:${(warehouse.address() as AddressInfo).port}`;
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    await new Promise((resolve) => warehouse?.close(resolve));
    await app?.cleanup();
  });

  const eve = (args: readonly string[]) =>
    execFileAsync(
      process.execPath,
      [join(app.appRoot, "node_modules", "eve", "bin", "eve.js"), ...args],
      {
        cwd: app.appRoot,
        env: { ...process.env, WAREHOUSE_URL: warehouseUrl },
        timeout: SCENARIO_TIMEOUT_MS,
      },
    );

  it(
    "records the schedule's delivery as the app, sends nothing, and reports the gated tool hidden",
    async () => {
      const { stdout } = await eve(["schedule", "run", "weekly-summary", "--dry-run", "--json"]);
      const result = JSON.parse(stdout);

      expect(result.error).toBeNull();
      expect(result.deliveries).toHaveLength(1);
      const [delivery] = result.deliveries;
      expect(delivery).toMatchObject({
        auth: { authenticator: "app", principalId: "eve:app", principalType: "runtime" },
        channel: "digest",
        message: "Write the weekly revenue summary.",
        target: { channelId: "C0ATLAS01" },
      });
      const toolNames = delivery.turn.tools.map((tool: { name: string }) => tool.name);
      expect(toolNames).toContain("lookup_account");
      expect(toolNames).not.toContain("revenue_forecast");
      expect(delivery.turn.hiddenTools).toContainEqual({
        name: "revenue_forecast",
        reason: "defineDynamic returned undefined for principalType runtime",
        source: "tools/revenue_forecast.ts",
      });
      expect(delivery.turn.instructions.system.join("\n")).toContain("weekly revenue summary");

      expect(result.fetches).toEqual([
        { method: "GET", url: `${warehouseUrl}/v1/accounts?active=true` },
      ]);
      expect(warehouseRequests).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "lists the gated tool for a finance user and hides it for the schedule",
    async () => {
      const finance = JSON.parse(
        (await eve(["info", "--as", "user:groups=finance", "--json"])).stdout,
      );
      const schedule = JSON.parse((await eve(["info", "--as", "schedule", "--json"])).stdout);

      expect(finance.as.tools.map((tool: { name: string }) => tool.name)).toEqual(
        expect.arrayContaining(["lookup_account", "revenue_forecast"]),
      );
      expect(finance.as.hiddenTools).toEqual([]);
      expect(schedule.as.hiddenTools.map((tool: { name: string }) => tool.name)).toEqual([
        "revenue_forecast",
      ]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "exits 1 with a suggestion for an unknown schedule",
    async () => {
      const failure = await eve(["schedule", "run", "weekly-sumary", "--dry-run"]).then(
        () => undefined,
        (error: { code?: number; stderr?: string }) => error,
      );

      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain('Did you mean "weekly-summary"?');
    },
    SCENARIO_TIMEOUT_MS,
  );
});
