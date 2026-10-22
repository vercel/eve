import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

// Each test grades one requirement from the prompt, independently of the others,
// so the share of passing tests is a partial score for the run.

const projectRoot = "atlas";
const agentRoot = `${projectRoot}/agent`;
const warehouse = "https://warehouse.lumen.dev/v1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("creates an eve project for Atlas", () => {
  const packageJson = JSON.parse(readFileSync(`${projectRoot}/package.json`, "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(packageJson.dependencies?.eve).toBeTruthy();
  expect(packageJson.scripts?.build).toBe("eve build");
  expect(instructionsSource()).toMatch(/Atlas/);
  expect(instructionsSource()).toMatch(/Lumen/);
});

test("the project typechecks and builds", { timeout: 600_000 }, () => {
  for (const script of ["typecheck", "build"]) {
    execFileSync("npm", ["run", script], { cwd: projectRoot, stdio: "pipe", timeout: 280_000 });
  }
});

test("answers employees in Slack with portable credentials", () => {
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

test("admits only company SSO tokens on the HTTP API", () => {
  const file = `${agentRoot}/channels/eve.ts`;
  expect(existsSync(file)).toBe(true);
  const source = readFileSync(file, "utf8");
  expect(source).toMatch(/from\s+["']eve\/channels\/eve["']/);
  expect(source).toMatch(/\boidc\s*\(/);
  expect(source).toMatch(/["']https:\/\/sso\.lumen\.dev\/?["']/);
  expect(source).toMatch(/audiences\s*:\s*\[\s*["']atlas["']\s*\]/);
  // localDev() never authenticates a production request; every other helper would.
  expect(source).not.toMatch(/\b(?:placeholderAuth|vercelOidc|httpBasic|jwtHmac|none)\s*\(/);
});

test("run_sql sends read-only queries to the warehouse", async () => {
  const tool = await load(`${agentRoot}/tools/run_sql.ts`);
  const requests = stubWarehouse();

  const output = await tool.execute(sqlInput(tool, "SELECT count(*) FROM analytics.customers"), {});
  expect(requests).toHaveLength(1);
  const [{ url, init }] = requests;
  expect(url).toBe(`${warehouse}/query`);
  expect(init.method?.toUpperCase()).toBe("POST");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
  expect(JSON.parse(String(init.body))).toEqual({
    sql: "SELECT count(*) FROM analytics.customers",
  });
  expect(JSON.stringify(output)).toContain("warehouse-row");

  await tool.execute(
    sqlInput(tool, "WITH recent AS (SELECT * FROM analytics.orders) SELECT count(*) FROM recent"),
    {},
  );
  expect(requests).toHaveLength(2);
});

test("run_sql refuses writes without calling the warehouse", async () => {
  const tool = await load(`${agentRoot}/tools/run_sql.ts`);
  const requests = stubWarehouse();
  // A tool that never calls the warehouse would refuse everything trivially.
  await tool.execute(sqlInput(tool, "SELECT 1"), {});
  expect(requests).toHaveLength(1);

  for (const query of [
    "DELETE FROM analytics.orders",
    "update analytics.orders set total = 0",
    "SELECT 1; DROP TABLE analytics.orders",
    "INSERT INTO analytics.orders (id) VALUES (1)",
  ]) {
    const parsed = tool.inputSchema.safeParse({ query });
    if (parsed.success) await tool.execute(parsed.data, {}).catch(() => undefined);
    expect(requests, query).toHaveLength(1);
  }
});

test("run_sql asks a person before touching the pii schema", async () => {
  const tool = await load(`${agentRoot}/tools/run_sql.ts`);
  const policy = typeof tool.approval === "function" ? tool.approval : tool.approval?.request;
  expect(typeof policy).toBe("function");
  const needsApproval = async (query: string) =>
    requiresApproval(
      await policy({
        approvedTools: new Set(),
        callId: "sql-call",
        session: {},
        toolInput: sqlInput(tool, query),
        toolName: "run_sql",
      }),
    );

  expect(await needsApproval("SELECT email FROM pii.employees")).toBe(true);
  expect(await needsApproval("select u.id from analytics.orders o join PII.users u on true")).toBe(
    true,
  );
  expect(await needsApproval("SELECT count(*) FROM analytics.customers")).toBe(false);
});

test("reads Notion as the signed-in employee through a narrow MCP connection", async () => {
  const file = sourceFiles("connections", /\.ts$/).find((path) =>
    readFileSync(path, "utf8").includes("mcp.notion.com/mcp"),
  );
  expect(file).toBeDefined();
  const connection = await load(file!);
  expect(connection.url).toBe("https://mcp.notion.com/mcp");
  expect(new Set(connection.tools?.allow)).toEqual(new Set(["search", "fetch"]));
  expect(connection.tools?.block).toBeUndefined();

  const auth = typeof connection.auth === "function" ? await connection.auth({}) : connection.auth;
  expect(auth?.vercelConnect?.connector).toBe("mcp.notion.com/atlas");
  expect(auth?.principalType ?? auth?.credentialOwner).toBe("user");
});

test("shows revenue_forecast only to the finance group", async () => {
  const definition = await load(`${agentRoot}/tools/revenue_forecast.ts`);
  expect(forecastTool(await resolveDynamic(definition, ["eng", "finance"]))).toBeDefined();
  expect(forecastTool(await resolveDynamic(definition, ["eng"]))).toBeUndefined();
  expect(forecastTool(await resolveDynamic(definition, undefined))).toBeUndefined();
});

test("revenue_forecast reads the quarter's forecast", async () => {
  const definition = await load(`${agentRoot}/tools/revenue_forecast.ts`);
  const tool = forecastTool(await resolveDynamic(definition, ["finance"]));
  expect(tool).toBeDefined();
  const requests = stubWarehouse();
  const parsed = tool.inputSchema.safeParse({ quarter: "2026-Q4" });
  expect(parsed.success).toBe(true);
  const output = await tool.execute(parsed.data, {});

  expect(requests).toHaveLength(1);
  const url = new URL(requests[0].url);
  expect(`${url.origin}${url.pathname}`).toBe(`${warehouse}/forecast`);
  expect(url.searchParams.get("quarter")).toBe("2026-Q4");
  expect((requests[0].init.method ?? "GET").toUpperCase()).toBe("GET");
  expect(new Headers(requests[0].init.headers).get("authorization")).toBe("Bearer test-token");
  expect(JSON.stringify(output)).toContain("warehouse-row");
});

test("keeps metric definitions in a packaged skill with a reference file", () => {
  const skill = sourceFiles("skills", /^SKILL\.md$/).find((file) => {
    const references = sourceFiles(relativeToAgent(dirname(file)), /\.md$/).filter(
      (path) => path !== file,
    );
    return references.some((path) => /one-time/i.test(readFileSync(path, "utf8")));
  });
  expect(skill).toBeDefined();
  expect(readFileSync(skill!, "utf8")).toMatch(/^---[\s\S]*?\bdescription\s*:[\s\S]*?---/);
  const reference = sourceFiles(relativeToAgent(dirname(skill!)), /\.md$/)
    .filter((path) => path !== skill)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  expect(reference).toMatch(/ARR/);
  expect(reference).toMatch(/30 days/i);
  expect(reference).toMatch(/12 months/i);
  // Always-on instructions would carry the definitions on every turn.
  expect(instructionsSource()).not.toMatch(/one-time|30 days/i);
});

test("posts the weekly metrics summary to Slack", async () => {
  const [file, ...rest] = sourceFiles("schedules", /\.ts$/);
  expect(rest).toHaveLength(0);
  expect(readFileSync(file, "utf8")).toMatch(/cron\s*:\s*["']0 15 \* \* (?:1|MON)["']/i);
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
  expect(deliveries[0].channel).toBe(slack);
  expect(deliveries[0].target).toMatchObject({ channelId: "C0ATLAS01" });
  expect(deliveries[0].auth).toBe(appAuth);
});

test("ships an eve eval with run_sql stubbed", { timeout: 120_000 }, () => {
  expect(existsSync(`${projectRoot}/evals/evals.config.ts`)).toBe(true);
  const evals = sourceFilesUnder(`${projectRoot}/evals`, /\.eval\.ts$/).map((file) =>
    readFileSync(file, "utf8"),
  );
  const evalSource = evals.find((source) => /run_sql/.test(source));
  expect(evalSource).toBeDefined();
  expect(evalSource).toMatch(/defineEval\s*\(/);
  // A stub rule has to name the tool; an empty stub list would call the real warehouse.
  expect(evalSource).toMatch(/\bstubs\b/);
  expect(evalSource).toMatch(/tool\s*:\s*["']run_sql["']/);
  expect(evalSource).toMatch(/calledTool\s*\(\s*["']run_sql["']/);

  const listed = execFileSync("npx", ["eve", "eval", "--list"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 90_000,
  });
  expect(listed.trim()).not.toBe("");
});

function instructionsSource(): string {
  for (const name of ["instructions.md", "instructions.ts"]) {
    const path = `${agentRoot}/${name}`;
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error("The agent has no root instructions.");
}

function sourceFiles(directory: string, pattern = /\.(?:ts|md)$/): string[] {
  return sourceFilesUnder(`${agentRoot}/${directory}`, pattern);
}

function sourceFilesUnder(root: string, pattern: RegExp): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function relativeToAgent(path: string): string {
  return path.slice(agentRoot.length + 1);
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}

function stubWarehouse(): Array<{ url: string; init: RequestInit }> {
  vi.stubEnv("WAREHOUSE_TOKEN", "test-token");
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({
      url,
      init: input instanceof Request ? { ...init, method: input.method } : init,
    });
    return Response.json({ rows: [{ id: "warehouse-row" }] });
  });
  return requests;
}

function sqlInput(
  tool: { inputSchema: { safeParse(input: unknown): { success: boolean; data?: unknown } } },
  query: string,
) {
  const parsed = tool.inputSchema.safeParse({ query });
  if (!parsed.success) throw new Error(`The run_sql schema rejected ${JSON.stringify(query)}.`);
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

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function resolveDynamic(definition: any, groups: string[] | undefined): Promise<unknown> {
  expect(definition?.kind).toBe("eve:dynamic");
  const handler = definition.events?.["session.started"] ?? definition.events?.["turn.started"];
  expect(typeof handler).toBe("function");
  const current =
    groups === undefined
      ? undefined
      : { principalId: "sso:ada", principalType: "user", attributes: { groups } };
  return handler({}, { session: { id: "session-1", auth: { current } } });
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
function forecastTool(resolved: any): any {
  if (resolved === null || resolved === undefined) return undefined;
  if (typeof resolved.execute === "function") return resolved;
  return resolved.revenue_forecast;
}
