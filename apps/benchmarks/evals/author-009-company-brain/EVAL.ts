import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Each test grades one requirement from the prompt, independently of the others,
// so the share of passing tests is a partial score for the run.

const projectRoot = "atlas";
const agentRoot = `${projectRoot}/agent`;
const warehouse = "https://warehouse.lumen.dev/v1";
const specialistModel = "anthropic/claude-sonnet-5";
// The principal schedules pass as `appAuth`; `isScheduleAuth()` matches these three fields.
const scheduleAuth = { authenticator: "app", principalId: "eve:app", principalType: "runtime" };

/** A signed-in employee's groups, the schedule's app principal, or nobody. */
type Caller = string[] | "schedule" | undefined;

// Set before any authored module loads: a module may read credentials at import
// time, and the ESM cache keeps whatever it saw first.
beforeEach(() => {
  vi.stubEnv("WAREHOUSE_TOKEN", "test-token");
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  vi.stubEnv("SLACK_SIGNING_SECRET", "test-signing-secret");
});

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
  expect(channel).toBeDefined();
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
  // eve's oidc() or verifyOidc(), or a JWT verification of the same issuer and
  // audience, wherever the channel imports it from.
  const auth = resolvedSource(file);
  expect(auth).toMatch(/\b(?:oidc|verifyOidc|jwtVerify)\s*\(/);
  expect(auth).toMatch(/["']https:\/\/sso\.lumen\.dev\/?["']/);
  // The audience may be inline or in a constant: `audiences: [SSO_AUDIENCE]`.
  expect(auth).toMatch(/\baudiences?\s*:/);
  expect(auth).toMatch(/["']atlas["']/);
  // localDev() never authenticates a production request; every other helper would.
  expect(source).not.toMatch(/\b(?:placeholderAuth|vercelOidc|httpBasic|jwtHmac|none)\s*\(/);
});

test("run_sql sends read-only queries to the warehouse", async () => {
  const tool = await load(`${agentRoot}/tools/run_sql.ts`);
  const requests = stubWarehouse();

  const output = await tool.execute(
    await sqlInput(tool, "SELECT count(*) FROM analytics.customers"),
    toolContext([]),
  );
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
    await sqlInput(
      tool,
      "WITH recent AS (SELECT * FROM analytics.orders) SELECT count(*) FROM recent",
    ),
    toolContext([]),
  );
  expect(requests).toHaveLength(2);
});

test("run_sql refuses writes without calling the warehouse", async () => {
  const tool = await load(`${agentRoot}/tools/run_sql.ts`);
  const requests = stubWarehouse();
  // A tool that never calls the warehouse would refuse everything trivially.
  await tool.execute(await sqlInput(tool, "SELECT 1"), toolContext([]));
  expect(requests).toHaveLength(1);

  for (const query of [
    "DELETE FROM analytics.orders",
    "update analytics.orders set total = 0",
    "SELECT 1; DROP TABLE analytics.orders",
    "INSERT INTO analytics.orders (id) VALUES (1)",
  ]) {
    const parsed = await parseInput(tool, { query });
    if (parsed.success) await tool.execute(parsed.data, toolContext([])).catch(() => undefined);
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
        session: session([]),
        toolInput: await sqlInput(tool, query),
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
    resolvedSource(path).includes("mcp.notion.com/mcp"),
  );
  expect(file).toBeDefined();
  const connection = await load(file!);
  expect(connection.url).toBe("https://mcp.notion.com/mcp");
  expectOnlySearchAndFetch(connection.tools?.allow);
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
  const parsed = await parseInput(tool, { quarter: "2026-Q4" });
  expect(parsed.success).toBe(true);
  // Re-checking the group inside execute is a valid second layer, so run as a finance user.
  const output = await tool.execute(parsed.data, toolContext(["finance"]));

  expect(requests).toHaveLength(1);
  const url = new URL(requests[0].url);
  expect(`${url.origin}${url.pathname}`).toBe(`${warehouse}/forecast`);
  expect(url.searchParams.get("quarter")).toBe("2026-Q4");
  expect((requests[0].init.method ?? "GET").toUpperCase()).toBe("GET");
  expect(new Headers(requests[0].init.headers).get("authorization")).toBe("Bearer test-token");
  expect(JSON.stringify(output)).toContain("warehouse-row");
});

test("the weekly summary gets the revenue forecast", async () => {
  const definition = await load(`${agentRoot}/tools/revenue_forecast.ts`);
  const tool = forecastTool(await resolveDynamic(definition, "schedule"));
  const requests = stubWarehouse();
  if (tool !== undefined) {
    // The scheduled turn has no signed-in employee, so the tool resolves for the app.
    const parsed = await parseInput(tool, { quarter: "2027-Q1" });
    expect(parsed.success).toBe(true);
    await tool.execute(parsed.data, toolContext("schedule"));
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.get("quarter")).toBe("2027-Q1");
    return;
  }
  // Or the schedule fetches the forecast itself and hands it to the summary.
  const { deliveries } = await runSchedule();
  expect(requests.map((request) => new URL(request.url).pathname)).toContain("/v1/forecast");
  expect(deliveries).toHaveLength(1);
});

test("analyze asks both specialists at the same time and returns both answers", async () => {
  const tool = await load(`${agentRoot}/tools/analyze.ts`);
  const sent: Array<{ name: string; message: unknown }> = [];
  // A sequential implementation waits for the first answer before asking the second specialist.
  let sentWhenFirstAnswerRead: number | undefined;
  const ctx = {
    ...toolContext(["eng"]),
    agents: {},
    ask: async () => {
      throw new Error("analyze should not ask the employee anything.");
    },
    agent: (name: string) => ({
      send: async (message: unknown) => {
        sent.push({ name, message });
        return {
          result: async () => {
            sentWhenFirstAnswerRead ??= sent.length;
            return {
              status: "completed",
              reply: `${name}-answer`,
              data: { answer: `${name}-answer` },
              sessionEnded: false,
            };
          },
        };
      },
    }),
  };
  const parsed = await parseInput(tool, { question: "Why did ARR dip in March?" });
  expect(parsed.success).toBe(true);
  // A workflow tool may run its calls as tasks; both entry points take (input, ctx).
  const run = tool.execute ?? tool.task;
  expect(typeof run).toBe("function");
  const output = await run(parsed.data, ctx);

  expect(sent.map((entry) => entry.name).sort()).toEqual(["analyst", "researcher"]);
  for (const entry of sent) expect(JSON.stringify(entry.message)).toContain("ARR dip in March");
  expect(sentWhenFirstAnswerRead).toBe(2);
  expect(JSON.stringify(output)).toContain("analyst-answer");
  expect(JSON.stringify(output)).toContain("researcher-answer");
});

test("the specialists are subagents hidden from the main model", async () => {
  for (const name of ["analyst", "researcher"]) {
    const definition = await load(`${agentRoot}/subagents/${name}/agent.ts`);
    expect(definition.description, name).toBeTruthy();
    expect(definition.model, name).toBe(specialistModel);
    const disabled =
      definition.tool === false ||
      sourceFiles("tools", /\.ts$/).some(
        (file) =>
          file === `${agentRoot}/tools/${name}.ts` &&
          /disableTool\s*\(/.test(readFileSync(file, "utf8")),
      );
    expect(disabled, name).toBe(true);
  }
});

test("analyst queries the warehouse read-only and cannot read Notion", async () => {
  const tool = await load(`${agentRoot}/subagents/analyst/tools/run_sql.ts`);
  const requests = stubWarehouse();
  await tool.execute(
    await sqlInput(tool, "SELECT count(*) FROM analytics.customers"),
    toolContext([]),
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(`${warehouse}/query`);
  const parsed = await parseInput(tool, { query: "DELETE FROM analytics.orders" });
  if (parsed.success) await tool.execute(parsed.data, toolContext([])).catch(() => undefined);
  expect(requests).toHaveLength(1);

  const notion = sourceFiles("subagents/analyst", /\.ts$/).filter((file) =>
    /mcp\.notion\.com/.test(resolvedSource(file)),
  );
  expect(notion).toEqual([]);
});

test("researcher reads Notion as the employee and cannot query the warehouse", async () => {
  const file = sourceFiles("subagents/researcher/connections", /\.ts$/).find((path) =>
    /mcp\.notion\.com\/mcp/.test(resolvedSource(path)),
  );
  expect(file).toBeDefined();
  const connection = await load(file!);
  expect(connection.url).toBe("https://mcp.notion.com/mcp");
  expectOnlySearchAndFetch(connection.tools?.allow);
  const auth = typeof connection.auth === "function" ? await connection.auth({}) : connection.auth;
  expect(auth?.vercelConnect?.connector).toBe("mcp.notion.com/atlas");
  expect(auth?.principalType ?? auth?.credentialOwner).toBe("user");

  expect(sourceFiles("subagents/researcher/tools", /^run_sql\.ts$/)).toEqual([]);
  const warehouseAccess = sourceFiles("subagents/researcher", /\.ts$/).filter((path) =>
    /warehouse\.lumen\.dev/.test(resolvedSource(path)),
  );
  expect(warehouseAccess).toEqual([]);
});

test("keeps metric definitions in a skill loaded on demand", async () => {
  // A single-file skill (`skills/<name>.md`), or a packaged one whose definitions
  // sit in SKILL.md itself or in a file next to it.
  const packaged = sourceFiles("skills", /^SKILL\.md$/).map((file) => ({
    file,
    text: sourceFiles(relativeToAgent(dirname(file)), /\.md$/)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  }));
  const singleFile = sourceFiles("skills", /\.md$/)
    .filter((file) => dirname(file) === `${agentRoot}/skills` && !file.endsWith("/SKILL.md"))
    .map((file) => ({ file, text: readFileSync(file, "utf8") }));
  // Or a `defineSkill({ content, files })` module, possibly re-exported from lib/.
  const defined = await Promise.all(
    sourceFiles("skills", /\.ts$/)
      .filter((file) => dirname(file) === `${agentRoot}/skills`)
      .map(async (file) => {
        const definition = await load(file);
        return {
          file,
          text: [definition?.content, ...strings(definition?.files)].join("\n"),
        };
      }),
  );
  const skill = [...packaged, ...singleFile, ...defined].find(({ text }) => /one-time/i.test(text));
  expect(skill).toBeDefined();
  // Only a packaged SKILL.md must describe itself; a single file falls back to its name.
  if (skill!.file.endsWith("/SKILL.md")) {
    expect(readFileSync(skill!.file, "utf8")).toMatch(/^---[\s\S]*?\bdescription\s*:[\s\S]*?---/);
  }
  const reference = skill!.text;
  expect(reference).toMatch(/ARR/);
  // Prose wraps and may spell numbers out: "active 12\nmonths ago", "twelve months".
  expect(reference).toMatch(/\b(?:30|thirty)\s+days\b/i);
  expect(reference).toMatch(/\b(?:12|twelve)\s+months\b/i);
  // Always-on instructions would carry the definitions on every turn.
  expect(instructionsSource()).not.toMatch(/one-time|\b(?:30|thirty)\s+days\b/i);
});

test("posts the weekly metrics summary to Slack", async () => {
  const [file, ...rest] = sourceFiles("schedules", /\.ts$/);
  expect(rest).toHaveLength(0);
  const schedule = await load(file);
  expect(String(schedule.cron).trim()).toMatch(/^0 15 \* \* (?:1|MON)$/i);
  expect(typeof schedule.run).toBe("function");
  const slack = await load(slackChannelFile());
  // A schedule may look up data before it posts; keep that off the network.
  stubWarehouse();
  const { appAuth, deliveries } = await runSchedule();

  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].channel).toBe(slack);
  expect(deliveries[0].target).toMatchObject({ channelId: "C0ATLAS01" });
  expect(deliveries[0].auth).toBe(appAuth);
});

async function runSchedule() {
  const [file] = sourceFiles("schedules", /\.ts$/);
  expect(file).toBeDefined();
  const schedule = await load(file!);
  const appAuth = { ...scheduleAuth, attributes: {} };
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
  return { appAuth, deliveries };
}

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

/** A module's source plus the project files it imports, so re-exports count. */
function resolvedSource(path: string, seen = new Set<string>()): string {
  if (seen.has(path) || !existsSync(path)) return "";
  seen.add(path);
  const source = readFileSync(path, "utf8");
  const imported = [...source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((match) => {
    const base = join(dirname(path), match[1]!.replace(/\.js$/, ""));
    return [base, `${base}.ts`, join(base, "index.ts")].find(
      (candidate) => existsSync(candidate) && candidate.endsWith(".ts"),
    );
  });
  return [source, ...imported.map((file) => (file ? resolvedSource(file, seen) : ""))].join("\n");
}

function relativeToAgent(path: string): string {
  return path.slice(agentRoot.length + 1);
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}

/** Every string inside a value, such as the file contents of a `defineSkill({ files })`. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

/** Notion's hosted server names these `notion-search` and `notion-fetch`; either spelling counts. */
function expectOnlySearchAndFetch(allow: unknown) {
  expect(Array.isArray(allow)).toBe(true);
  const names = new Set((allow as unknown[]).map((name) => String(name).replace(/^notion-/, "")));
  expect(names).toEqual(new Set(["search", "fetch"]));
}

function slackChannelFile(): string {
  const file = sourceFiles("channels", /\.ts$/).find((path) =>
    /slackChannel\s*\(/.test(readFileSync(path, "utf8")),
  );
  if (file === undefined) throw new Error("The agent has no Slack channel.");
  return file;
}

function stubWarehouse(): Array<{ url: string; init: RequestInit }> {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    if (input instanceof Request) {
      const body = await input.clone().text();
      requests.push({
        url: input.url,
        init: { method: input.method, headers: input.headers, body: body || undefined, ...init },
      });
    } else {
      requests.push({ url: String(input), init });
    }
    return Response.json({ rows: [{ id: "warehouse-row" }] });
  });
  return requests;
}

/**
 * Validates input the way eve does for any accepted schema: Standard Schema
 * (Zod and others), or a plain JSON Schema object, which eve does not validate here.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function parseInput(tool: any, input: unknown): Promise<{ success: boolean; data?: any }> {
  const standard = tool.inputSchema?.["~standard"];
  if (typeof standard?.validate === "function") {
    const result = await standard.validate(input);
    return result.issues ? { success: false } : { success: true, data: result.value };
  }
  if (typeof tool.inputSchema?.safeParse === "function") return tool.inputSchema.safeParse(input);
  return { success: true, data: input };
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function sqlInput(tool: any, query: string) {
  const parsed = await parseInput(tool, { query });
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
async function resolveDynamic(definition: any, caller: Caller): Promise<unknown> {
  expect(definition?.kind).toBe("eve:dynamic");
  expect(typeof definition.evaluate).toBe("function");
  return definition.evaluate({
    session: session(caller),
    turn: null,
    now: new Date(),
    model: { id: "anthropic/claude-sonnet-5" },
    memo: async (_key: unknown, fn: () => unknown) => fn(),
    messages: async () => [],
  });
}

function session(caller: Caller) {
  const current =
    caller === "schedule"
      ? { ...scheduleAuth, attributes: {} }
      : caller === undefined
        ? undefined
        : {
            authenticator: ssoAuthenticator(),
            principalId: "sso:ada",
            principalType: "user",
            issuer: "https://sso.lumen.dev",
            subject: "ada",
            attributes: { groups: caller },
          };
  return { id: "session-1", auth: { current } };
}

/**
 * The authenticator name the agent's HTTP channel gives SSO callers: eve's
 * `oidc()` uses "oidc", and a custom authenticator may relabel it. Code that
 * trusts groups only from SSO callers then sees the name it checks for.
 */
function ssoAuthenticator(): string {
  const source = resolvedSource(`${agentRoot}/channels/eve.ts`);
  const named = /\bauthenticator\s*:\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))/.exec(source);
  if (named?.[1] !== undefined) return named[1];
  // `authenticator: SSO_AUTHENTICATOR`, with the constant declared in an imported module.
  const constant = named?.[2];
  const declared =
    constant === undefined
      ? undefined
      : new RegExp(`\\b${constant}\\s*=\\s*["']([^"']+)["']`).exec(source)?.[1];
  return declared ?? "oidc";
}

function toolContext(caller: Caller) {
  return { session: session(caller), callId: "call-1", abortSignal: new AbortController().signal };
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
function forecastTool(resolved: any): any {
  if (resolved === null || resolved === undefined) return undefined;
  if (typeof resolved.execute === "function") return resolved;
  return resolved.revenue_forecast;
}
