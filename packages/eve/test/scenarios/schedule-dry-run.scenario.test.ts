import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
  dependencies: { zod: "4.5.4" },
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
    "agent/schedules/requests.ts": `import { defineDynamicSchedules } from "eve/experimental/schedules";
import { z } from "zod";
import digest from "../channels/digest";
export default defineDynamicSchedules({
  inputSchema: z.object({ task: z.string() }).strict(),
  tool: false,
  async auth({ principal }) {
    await fetch(process.env.WAREHOUSE_URL + "/v1/members/" + principal.principalId);
    return principal.principalId === "mallory" ? null : { attributes: { team: "revenue" } };
  },
  async run({ payload, to }) {
    await to(digest, { channelId: "C0TEAM" }).send("Do this now: " + payload.task);
  },
});
`,
    "agent/tools/schedule_report.ts": `import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
export default defineDynamic((ctx) =>
  ctx.session.schedule?.definition === "weekly-summary"
    ? defineTool({
        description: "File the weekly report.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "filed",
      })
    : null,
);
`,
    "agent/schedules/weekly-summary.ts": `import { defineSchedule } from "eve/schedules";
import digest from "../channels/digest";
void fetch(process.env.WAREHOUSE_URL + "/v1/boot").catch(() => undefined);
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

describe("eve schedule run --dry-run and eve send --dry-run", () => {
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
    await writeFile(join(app.appRoot, ".env.local"), `WAREHOUSE_URL=${warehouseUrl}\n`);
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
        env: { ...process.env, WAREHOUSE_URL: undefined },
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
      expect(toolNames).toEqual(expect.arrayContaining(["lookup_account", "schedule_report"]));
      expect(toolNames).not.toContain("revenue_forecast");
      expect(delivery.turn.hiddenTools).toContainEqual({
        name: "revenue_forecast",
        reason: "defineDynamic returned undefined for principalType runtime",
        source: "tools/revenue_forecast.ts",
      });
      expect(delivery.turn.instructions.system.join("\n")).toContain("weekly revenue summary");

      expect(result.fetches).toEqual(
        expect.arrayContaining([
          { method: "GET", url: `${warehouseUrl}/v1/boot` },
          { method: "GET", url: `${warehouseUrl}/v1/accounts?active=true` },
        ]),
      );
      expect(warehouseRequests).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "runs a dynamic schedule as the creator auth() resolves, without the creator's groups",
    async () => {
      const { stdout } = await eve([
        "schedule",
        "run",
        "requests",
        "--dry-run",
        "--payload",
        JSON.stringify({ task: "Summarize Q3" }),
        "--as",
        "user:id=sso:alice:authenticator=sso",
        "--json",
      ]);
      const result = JSON.parse(stdout);
      const resolved = {
        attributes: { team: "revenue" },
        authenticator: "sso",
        principalId: "sso:alice",
        principalType: "user",
      };

      expect(result).toMatchObject({ error: null, kind: "dynamic", creator: { auth: resolved } });
      expect(result.deliveries).toHaveLength(1);
      expect(result.deliveries[0]).toMatchObject({
        auth: resolved,
        message: "Do this now: Summarize Q3",
        target: { channelId: "C0TEAM" },
      });
      expect(result.deliveries[0].turn.hiddenTools).toContainEqual(
        expect.objectContaining({
          name: "revenue_forecast",
          reason: "defineDynamic returned undefined for principalType user",
        }),
      );
      expect(result.fetches).toContainEqual({
        method: "GET",
        url: `${warehouseUrl}/v1/members/sso:alice`,
      });

      const denied = await eve([
        "schedule",
        "run",
        "requests",
        "--dry-run",
        "--payload",
        JSON.stringify({ task: "Summarize Q3" }),
        "--as",
        "user:id=mallory",
        "--json",
      ]).then(
        () => undefined,
        (error: { code?: number; stdout?: string }) => error,
      );
      expect(denied?.code).toBe(1);
      expect(JSON.parse(denied!.stdout!)).toMatchObject({
        creator: { auth: null },
        deliveries: [],
        error: expect.stringContaining('"auth" returned null'),
      });
      expect(warehouseRequests).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "previews a sent message: the gated tool for a finance user, hidden for an anonymous caller",
    async () => {
      const send = async (as: string) =>
        JSON.parse(
          (await eve(["send", "What's the Q3 forecast?", "--dry-run", "--as", as, "--json"]))
            .stdout,
        );
      const finance = await send("user:groups=finance");
      const anonymous = await send("anonymous");

      expect(finance.turn.tools.map((tool: { name: string }) => tool.name)).toEqual(
        expect.arrayContaining(["lookup_account", "revenue_forecast"]),
      );
      expect(finance.turn.hiddenTools.map((tool: { name: string }) => tool.name)).toEqual([
        "schedule_report",
      ]);
      expect(anonymous.turn.auth).toBeNull();
      expect(anonymous.turn.hiddenTools.map((tool: { name: string }) => tool.name)).toContain(
        "revenue_forecast",
      );
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
