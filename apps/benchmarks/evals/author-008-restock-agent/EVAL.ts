import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

const projectRoot = "restock-agent";
const agentRoot = `${projectRoot}/agent`;
const apiBaseUrl = "https://api.northstar-fulfillment.com";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("creates a buildable eve project for Restock", () => {
  const packageJson = JSON.parse(readFileSync(`${projectRoot}/package.json`, "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(packageJson.dependencies?.eve).toBeTruthy();
  expect(packageJson.scripts?.build).toBe("eve build");

  const instructions = instructionsSource();
  expect(instructions).toMatch(/Restock/);
  expect(instructions).toMatch(/Northstar|warehouse|inventory/i);
});

test("talks to the team through a Slack channel with portable credentials", () => {
  const [channel, ...rest] = sourceFiles("channels").filter((file) =>
    /slackChannel\s*\(/.test(readFileSync(file, "utf8")),
  );
  expect(rest).toHaveLength(0);
  expect(channel).toBe(`${agentRoot}/channels/slack.ts`);
  const source = readFileSync(channel, "utf8");
  expect(source).toMatch(/from\s+["']eve\/channels\/slack["']/);
  expect(source).not.toMatch(/connectSlackCredentials/);
  expect(source).not.toMatch(/xoxb-/);
});

test("reads inventory through a read-only OpenAPI connection", async () => {
  const [file, ...rest] = sourceFiles("connections");
  expect(rest).toHaveLength(0);
  const source = readFileSync(file, "utf8");
  expect(source).toMatch(/defineOpenAPIConnection\s*\(/);
  expect(source).toMatch(/NORTHSTAR_API_TOKEN/);

  const connection = await load(file);
  expect(new Set(connection.operations?.allow)).toEqual(new Set(["getStock", "listLowStock"]));
  expect(connection.operations?.block).toBeUndefined();
  expect(connection.baseUrl ?? connection.spec?.servers?.[0]?.url).toBe(apiBaseUrl);
  // The contract has no public URL, so it has to travel with the project.
  expect(typeof connection.spec).toBe("object");
  expect(Object.keys(connection.spec.paths)).toContain("/purchase-orders");

  vi.stubEnv("NORTHSTAR_API_TOKEN", "test-token");
  const auth = typeof connection.auth === "function" ? await connection.auth({}) : connection.auth;
  expect(auth?.credentialOwner ?? "app").toBe("app");
  expect(await auth.getToken({})).toMatchObject({ token: "test-token" });
});

test("places purchase orders through a typed tool", async () => {
  const file = `${agentRoot}/tools/create_purchase_order.ts`;
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toMatch(/defineTool\s*\(/);

  const tool = await load(file);
  expect(() => orderInput(tool, { quantity: 0, unitCostUsd: 10 })).toThrow();
  expect(() => orderInput(tool, { quantity: 1.5, unitCostUsd: 10 })).toThrow();
  expect(() => orderInput(tool, { quantity: 1, unitCostUsd: 0 })).toThrow();

  vi.stubEnv("NORTHSTAR_API_TOKEN", "test-token");
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({
      url,
      init: input instanceof Request ? { ...init, method: input.method } : init,
    });
    return Response.json({ id: "po_8812", status: "submitted" }, { status: 201 });
  });

  const output = await tool.execute(orderInput(tool, { quantity: 40, unitCostUsd: 12.5 }), {});
  expect(requests).toHaveLength(1);
  const [{ url, init }] = requests;
  expect(url).toBe(`${apiBaseUrl}/purchase-orders`);
  expect(init.method?.toUpperCase()).toBe("POST");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
  expect(JSON.parse(String(init.body))).toMatchObject({
    sku: "NS-1042",
    quantity: 40,
    unitCostUsd: 12.5,
  });
  expect(JSON.stringify(output)).toContain("po_8812");
});

test("asks a person to approve orders of $5,000 or more", async () => {
  const tool = await load(`${agentRoot}/tools/create_purchase_order.ts`);
  const policy = typeof tool.approval === "function" ? tool.approval : tool.approval?.request;
  expect(typeof policy).toBe("function");

  const needsApproval = async (quantity: number, unitCostUsd: number) =>
    requiresApproval(
      await policy({
        approvedTools: new Set(),
        callId: "po-call",
        session: {},
        toolInput: orderInput(tool, { quantity, unitCostUsd }),
        toolName: "create_purchase_order",
      }),
    );

  expect(await needsApproval(100, 49.99)).toBe(false);
  expect(await needsApproval(100, 50)).toBe(true);
  expect(await needsApproval(1, 5000)).toBe(true);
});

test("posts the weekday low-stock digest to the restock channel", async () => {
  const [file, ...rest] = sourceFiles("schedules");
  expect(rest).toHaveLength(0);
  expect(readFileSync(file, "utf8")).toMatch(/cron\s*:\s*["']0 13 \* \* (?:1-5|MON-FRI)["']/i);

  const schedule = await load(file);
  expect(typeof schedule.run).toBe("function");
  const slack = await load(`${agentRoot}/channels/slack.ts`);

  const appAuth = { authenticator: "app", principalId: "eve:app", principalType: "runtime" };
  const deliveries: Array<{ channel: unknown; target: unknown; message: unknown; auth: unknown }> =
    [];
  const pending: Array<Promise<unknown>> = [];
  await schedule.run({
    appAuth,
    waitUntil: (task: Promise<unknown>) => pending.push(task),
    to: (channel: unknown, target: unknown) => ({
      send: async (message: unknown, options?: { auth?: unknown }) => {
        deliveries.push({ channel, target, message, auth: options?.auth });
        return { sessionId: "session-1" };
      },
    }),
  });
  await Promise.all(pending);

  expect(deliveries).toHaveLength(1);
  const [delivery] = deliveries;
  expect(delivery.channel).toBe(slack);
  expect(delivery.target).toMatchObject({ channelId: "C0RESTOCK1" });
  expect(delivery.auth).toBe(appAuth);
  expect(JSON.stringify(delivery.message)).toMatch(/low[- ]stock|par level|digest/i);
});

test("keeps the restocking playbook in an on-demand skill", () => {
  const skills = sourceFiles("skills", /\.md$/).map((file) => readFileSync(file, "utf8"));
  const playbook = skills.find((source) => /discontinued/i.test(source));
  expect(playbook).toBeDefined();
  expect(playbook).toMatch(/par/i);
  expect(playbook).toMatch(/twice|2\s*x|2×|double/i);
  expect(playbook).toMatch(/\$?20,?000|\$20k/i);
  expect(playbook).toMatch(/ops lead/i);
  // Always-on instructions would load the playbook on every turn.
  expect(instructionsSource()).not.toMatch(/discontinued/i);
});

function instructionsSource(): string {
  for (const name of ["instructions.md", "instructions.ts"]) {
    const path = `${agentRoot}/${name}`;
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error("The agent has no root instructions.");
}

function sourceFiles(directory: string, pattern = /\.(?:ts|md)$/): string[] {
  const root = `${agentRoot}/${directory}`;
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}

function orderInput(
  tool: { inputSchema: { safeParse(input: unknown): { success: boolean; data?: unknown } } },
  order: { quantity: number; unitCostUsd: number },
) {
  const parsed = tool.inputSchema.safeParse({ sku: "NS-1042", ...order });
  if (!parsed.success) throw new Error(`The order schema rejected ${JSON.stringify(order)}.`);
  return parsed.data;
}

function requiresApproval(decision: unknown): boolean {
  if (decision === true || decision === "user-approval") return true;
  return (
    typeof decision === "object" &&
    decision !== null &&
    "type" in decision &&
    decision.type === "user-approval"
  );
}
