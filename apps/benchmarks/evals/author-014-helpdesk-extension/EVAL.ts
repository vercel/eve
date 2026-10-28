import type { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Each test grades one requirement from the prompt, independently of the others,
// so the share of passing tests is a partial score for the run.

const packageName = "@northwind/helpdesk";
const helpdeskUrl = "https://helpdesk.northwind.dev";
const dashboardUrl = "https://dash.northwind.dev/v1/new-tickets";

// Set before any authored module loads: the mount reads the token while it evaluates,
// and the ESM cache keeps whatever it saw first.
beforeEach(() => {
  vi.stubEnv("HELPDESK_TOKEN", "test-helpdesk-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("leaves the shared package unchanged", () => {
  const changes = execFileSync("git", ["status", "--porcelain", "--", "packages/helpdesk"], {
    encoding: "utf8",
  });
  expect(changes).toBe("");
});

test("the project typechecks and builds", { timeout: 600_000 }, () => {
  for (const script of ["typecheck", "build"]) {
    execFileSync("npm", ["run", script], { stdio: "pipe", timeout: 280_000 });
  }
});

test("adds the package to this agent for the support queue", async () => {
  expect(readFileSync(mountFile(), "utf8")).toMatch(/HELPDESK_TOKEN/);

  await import(pathToFileURL(resolve(mountFile())).href);
  const fetch = stubFetch();
  const search = (await packageTools()).search_tickets;
  await runTool(search, { query: "refund" });
  const [call] = await requests(fetch);
  const url = new URL(call!.url);
  expect(url.origin + url.pathname).toBe(`${helpdeskUrl}/v1/queues/support/tickets`);
  expect(call!.headers.get("authorization")).toBe("Bearer test-helpdesk-token");
});

test("keeps searching and creating tickets but cannot delete them", () => {
  const { tools } = eveInfo();
  expect(tools).toEqual(
    expect.arrayContaining([mounted("search_tickets"), mounted("create_ticket")]),
  );
  expect(tools).not.toContain(mounted("delete_ticket"));
});

test("asks for approval before closing a ticket", async () => {
  expect(compiledTools().get(mounted("close_ticket"))?.requiresApproval).toBe(true);

  const close = await load(toolSource(mounted("close_ticket")));
  const policy = typeof close.approval === "function" ? close.approval : close.approval?.request;
  expect(typeof policy).toBe("function");
  const toolInput = { ticketId: "T-7", resolution: "Refund issued." };
  const decision = await policy({
    callId: "call-1",
    session: graderSession,
    toolInput,
    toolName: "x",
  });
  expect(requiresApproval(decision)).toBe(true);

  // Once approved, the call still closes the ticket in the helpdesk.
  await import(pathToFileURL(resolve(mountFile())).href);
  const fetch = stubFetch();
  await runTool(close, toolInput);
  const [call] = await requests(fetch);
  expect(call!.method).toBe("POST");
  expect(call!.url).toBe(`${helpdeskUrl}/v1/tickets/T-7/close`);
  expect(JSON.parse(call!.body)).toEqual({ resolution: "Refund issued." });
});

// A hook or a wrapped `create_ticket` both satisfy this, so it runs the agent's own tools
// and hooks the way eve would for a call.
test("reports each new ticket to the dashboard", async () => {
  const fetch = stubFetch();
  await runCall(mounted("search_tickets"), { query: "refund" });
  expect(await dashboardReports(fetch)).toEqual([]);

  await runCall(mounted("create_ticket"), newTicket);
  const reports = await dashboardReports(fetch);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.method).toBe("POST");
  expect(JSON.parse(reports[0]!.body)).toEqual({ ticketId: "T-42", queue: "support" });
});

test("a dashboard outage does not fail ticket creation", async () => {
  const outages = [
    async () => {
      throw new TypeError("fetch failed");
    },
    async () => new Response("unavailable", { status: 503 }),
  ];
  for (const outage of outages) {
    const fetch = stubFetch(outage);
    const output = await runCall(mounted("create_ticket"), newTicket);
    expect(output).toMatchObject({ id: "T-42" });
    expect((await requests(fetch)).map((call) => call.url)).toContain(dashboardUrl);
  }
});

// oxlint-disable-next-line typescript/no-explicit-any -- graded files are untyped.
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The agent's mount of the package, wherever the agent put it and whatever it named it. */
function mount(): { file: string; namespace: string } {
  const root = "agent/extensions";
  const candidates = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? [{ file: join(root, entry.name, "extension.ts"), namespace: entry.name }]
          : entry.name.endsWith(".ts")
            ? [{ file: join(root, entry.name), namespace: entry.name.slice(0, -3) }]
            : [],
      )
    : [];
  const found = candidates.find(
    ({ file }) =>
      existsSync(file) &&
      new RegExp(`from\\s+["']${packageName}["']`).test(readFileSync(file, "utf8")),
  );
  if (found === undefined) throw new Error(`The agent does not mount ${packageName}.`);
  return found;
}

function mountFile(): string {
  return mount().file;
}

/** A tool's name in this agent: the mount's namespace, then the package's own name. */
function mounted(tool: string): string {
  return `${mount().namespace}__${tool}`;
}

// oxlint-disable-next-line typescript/no-explicit-any -- eve's JSON output is untyped here.
let info: any;

/** The compiled agent. Read once, after the build test has compiled the final project. */
// oxlint-disable-next-line typescript/no-explicit-any -- eve's JSON output is untyped here.
function eveInfo(): any {
  return (info ??= JSON.parse(
    execFileSync("npx", ["eve", "info", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }),
  ));
}

/** The root agent's compiled tools, which record whether each one can ask for approval. */
// oxlint-disable-next-line typescript/no-explicit-any -- the manifest is eve-internal.
function compiledTools(): Map<string, any> {
  const manifest = readJson(eveInfo().artifacts.compiledManifest);
  // oxlint-disable-next-line typescript/no-explicit-any -- the manifest is eve-internal.
  return new Map(manifest.tools.map((tool: any) => [tool.name, tool]));
}

/** The file eve loads for a tool, wherever the agent put its override. */
function toolSource(name: string): string {
  const manifest = readJson(eveInfo().artifacts.compiledManifest);
  // oxlint-disable-next-line typescript/no-explicit-any -- the manifest is eve-internal.
  const tool = manifest.tools.find((candidate: any) => candidate.name === name);
  const path = manifest.bindings?.[tool?.sourceId]?.backing?.sourcePath;
  if (typeof path !== "string") throw new Error(`eve has no source for ${name}.`);
  return path;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}

/** The package's tool definitions, resolved as the agent resolves its dependency. */
// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function packageTools(): Promise<Record<string, any>> {
  const root = realpathSync(`node_modules/${packageName}`);
  const entry = readJson(`${root}/package.json`).exports["./tools"].default;
  return import(pathToFileURL(resolve(root, entry)).href);
}

/** Hook files anywhere the agent can declare them, including a directory mount. */
function hookFiles(): string[] {
  return readdirSync("agent", { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => /(?:^|\/)hooks\//.test(path))
    .sort();
}

const newTicket = { customerEmail: "ada@example.com", subject: "Refund", body: "Charged twice." };

/**
 * Runs one call through the tool eve would load for it, then hands the settled call to every
 * `call.settled` subscriber. A hook that throws during a turn fails that turn in eve, so the
 * grader rethrows it rather than letting an outage pass. `toolResultFrom` recognizes a tool by the definition eve loaded under its name;
 * eve records that while it loads tools, so the grader records it the same way.
 */
async function runCall(name: string, input: unknown): Promise<unknown> {
  await import(pathToFileURL(resolve(mountFile())).href);
  const registry = (globalThis as Record<symbol, WeakMap<object, unknown> | undefined>)[
    Symbol.for("eve.resolved-definition-sources")
  ];
  for (const tool of eveInfo().tools as string[]) {
    if (!tool.startsWith(`${mount().namespace}__`)) continue;
    registry?.set(await load(toolSource(tool)), { kind: "tool", names: new Set([tool]) });
  }

  const tool = await load(toolSource(name));
  const output = await runTool(tool, input);

  const { emptySessionView, foldEvents } = await importProjectEve("./events");
  const callId = `call-${name}`;
  const facts = [
    { type: "session.started", data: {} },
    { type: "turn.started", data: { turnId: "turn-1", cause: { deliveryId: "d" }, follows: null } },
    { type: "model.requested", data: { runId: "run-1", owner: { turnId: "turn-1" } } },
    {
      type: "call.requested",
      data: { callId, owner: { runId: "run-1" }, capability: { kind: "tool", name }, input },
    },
    { type: "call.started", data: { callId } },
    { type: "call.settled", data: { callId, outcome: "completed", output } },
  ];
  const at = new Date().toISOString();
  const view = foldEvents(
    emptySessionView(),
    facts.map((fact, line) => ({ ...fact, meta: { position: { line, index: 0 }, at } })),
  );
  const ctx = {
    agent: { name: "support" },
    session: graderSession,
    position: { line: facts.length - 1, index: 0 },
    view,
    turn: { id: "turn-1" },
    now: new Date(),
    occurrence: { idempotencyKey: callId, abortSignal: new AbortController().signal },
    memo: (_key: string, compute: () => unknown) => compute(),
    cancel: vi.fn(),
  };
  for (const file of hookFiles()) {
    const events = (await load(file))?.events ?? {};
    for (const handler of [events["call.settled"], events["*"]].filter(Boolean)) {
      await handler(facts.at(-1), ctx);
    }
  }
  return output;
}

/** The person who approves calls in the grader, as eve hands them to an approved call. */
const graderApprover = {
  authenticator: "grader",
  issuer: "grader",
  principalId: "approver-1",
  principalType: "user",
  subject: "approver-1",
  attributes: {},
  getToken: async () => {
    throw new Error("The grader has no provider tokens.");
  },
};

/** The session eve hands tools, hooks, and approval policies: one conversation, in its first turn. */
const graderSession = {
  id: "session-1",
  auth: { current: null, initiator: null },
  turn: { id: "turn-1", sequence: 0 },
};

/**
 * Runs a tool call the way eve does: with a call context, inside a session whose state the
 * tools can read and write. Pass the same session to calls that belong to one conversation.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function runTool(tool: any, input: unknown, session = new SessionState()): Promise<unknown> {
  const parsed = tool.inputSchema?.parse ? tool.inputSchema.parse(input) : input;
  const call = {
    abortSignal: new AbortController().signal,
    callId: `call-${Math.random().toString(36).slice(2)}`,
    toolName: "graded",
    messages: [],
    channel: { kind: "eve" },
    // eve passes the session with every call; a tool may read its ID or the current turn.
    session: graderSession,
    // eve only runs a tool that asks for approval once a person approves, and tells the call who
    // did. A tool may check it as a second guard.
    ...(tool.approval === undefined ? {} : { approval: { responder: graderApprover } }),
  };
  return (await sessionStorage()).run({ context: session }, () => tool.execute(parsed, call));
}

/**
 * The process-wide storage eve keeps its session context in, shared by every eve copy. eve
 * creates it when its context module loads, and `eve/tools` and `eve/extension` don't load
 * that module, so a solution that never imports `eve/context` would leave it missing. Load
 * it from the project's eve first.
 */
async function sessionStorage(): Promise<AsyncLocalStorage<{ context: SessionState }>> {
  await importProjectEve("./context");
  const key = Symbol.for("eve.context-storage");
  const global = globalThis as Record<
    symbol,
    AsyncLocalStorage<{ context: SessionState }> | undefined
  >;
  const storage = global[key];
  if (!storage) throw new Error("eve context storage is missing after loading eve/context.");
  return storage;
}

/** A session's context values, as `defineState` reads and writes them. */
class SessionState {
  private readonly values = new Map<string, unknown>();
  get(key: { name: string }) {
    return this.values.get(key.name);
  }
  require(key: { name: string }) {
    if (!this.values.has(key.name)) throw new Error(`Context key "${key.name}" is not set.`);
    return this.values.get(key.name);
  }
  has(key: { name: string }) {
    return this.values.has(key.name);
  }
  set(key: { name: string }, value: unknown) {
    const next = typeof value === "function" ? value(this.values.get(key.name)) : value;
    this.values.set(key.name, next);
    return next;
  }
  ensure(key: { name: string }, create: () => unknown) {
    return this.has(key) ? this.values.get(key.name) : this.set(key, create());
  }
  delete(key: { name: string }) {
    return this.values.delete(key.name);
  }
  setVirtualContext(key: { name: string }, value: unknown) {
    this.values.set(key.name, value);
  }
  *entries() {}
}

/** Imports an `eve` entry point as the authored modules resolve it, sharing their module instance. */
// oxlint-disable-next-line typescript/no-explicit-any -- eve's types aren't installed at the root.
async function importProjectEve(subpath: string): Promise<any> {
  const eveRoot = "node_modules/eve";
  const target = readJson(`${eveRoot}/package.json`).exports[subpath];
  return import(pathToFileURL(resolve(eveRoot, target.import ?? target.default)).href);
}

/** Answers helpdesk calls like the helpdesk; `dashboard` answers everything else. */
function stubFetch(
  dashboard: () => Promise<Response> = async () => new Response(null, { status: 202 }),
) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { url, method } = new Request(input, init);
    if (!url.startsWith(helpdeskUrl)) return dashboard();
    if (url.endsWith("/close")) return Response.json({ id: "T-7", status: "closed" });
    if (method === "POST") return Response.json({ id: "T-42", queue: "support", status: "open" });
    return Response.json([]);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function dashboardReports(fetch: ReturnType<typeof stubFetch>) {
  return (await requests(fetch)).filter((call) => call.url === dashboardUrl);
}

async function requests(fetch: ReturnType<typeof stubFetch>) {
  return Promise.all(
    fetch.mock.calls.map(async (args: unknown[]) => {
      const [input, init] = args as [RequestInfo | URL, RequestInit | undefined];
      const { url, method, headers, body } = new Request(input, init);
      return { url, method, headers, body: body === null ? "" : await new Response(body).text() };
    }),
  );
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
