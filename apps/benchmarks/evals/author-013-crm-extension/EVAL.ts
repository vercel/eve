import type { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Each test grades one requirement from the prompt, independently of the others,
// so the share of passing tests is a partial score for the run.

const packageRoot = "packages/crm";
const packageName = "@acme/crm";
const defaultBaseUrl = "https://api.acme-crm.dev";

// Set before any authored module loads: the mount reads the key while it evaluates,
// and the ESM cache keeps whatever it saw first.
beforeEach(() => {
  vi.stubEnv("CRM_API_KEY", "test-crm-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("creates the @acme/crm extension package", () => {
  const packageJson = readJson(`${packageRoot}/package.json`);
  expect(packageJson.name).toBe(packageName);
  expect(packageJson.eve?.extension?.source).toBeTruthy();
  expect(packageJson.eve?.extension?.dist).toBeTruthy();
  const declaration = readFileSync(`${sourceRoot()}/extension.ts`, "utf8");
  expect(declaration).toMatch(/from\s+["']eve\/extension["']/);
  expect(declaration).toMatch(/defineExtension\s*\(/);
});

// The mount adds its own prefix, so a tool named `crm_lookup_customer` would surface as
// `crm__crm_lookup_customer`.
test("names the tools from their paths without the mount prefix", () => {
  for (const tool of ["lookup_customer", "add_note"]) {
    expect(existsSync(`${sourceRoot()}/tools/${tool}.ts`), tool).toBe(true);
  }
});

test("adds the package to this agent with the key from CRM_API_KEY", () => {
  // Found through its package import, not a relative path into its source.
  expect(readFileSync(mountFile(), "utf8")).toMatch(/CRM_API_KEY/);
  const dependencies = { ...readJson("package.json").dependencies };
  expect(dependencies[packageName]).toBeTruthy();
});

// Building first also builds the workspace extension, whose declarations the agent's
// typecheck reads.
test("the project typechecks and builds", { timeout: 600_000 }, () => {
  for (const script of ["build", "typecheck"]) {
    execFileSync("npm", ["run", script], { stdio: "pipe", timeout: 280_000 });
  }
});

test("gives the agent both tools and has it look customers up before notes", async () => {
  const info = eveInfo();
  expect(info.status).toBe("ready");
  expect(info.tools).toEqual(
    expect.arrayContaining([mounted("lookup_customer"), mounted("add_note")]),
  );
  expect(info.tools).not.toContain("lookup_customer");
  expect(info.tools).not.toContain("add_note");
  // Either add_note looks the customer up itself, so a note can't land on the wrong record,
  // or the extension contributes its own instructions fragment telling agents to.
  if (await addNoteLooksUpFirst()) return;
  expect(info.instructions).toMatch(new RegExp(`instructions/${mount().namespace}(?:__|\\.)`));
  expect(extensionInstructions()).toMatch(/look\w*\s+(?:\w+\s+){0,3}up|lookup|look-up/i);
  expect(extensionInstructions()).toMatch(/note/i);
});

test("requires an API key and defaults the base URL", async () => {
  const handle = await loadExtension();
  expect(() => handle({})).toThrow();
  handle({ apiKey: "another-key" });
  expect(handle.config).toMatchObject({ apiKey: "another-key", baseUrl: defaultBaseUrl });
});

test("lookup_customer reads the customer with the mounted key", async () => {
  await bindMount();
  const fetch = stubFetch();
  const output = await runTool(await loadTool("lookup_customer"), { email: customer.email });

  expect(JSON.stringify(output)).toContain(customer.id);
  const [call] = await requests(fetch);
  const url = new URL(call!.url);
  expect(call!.method).toBe("GET");
  expect(url.origin + url.pathname).toBe(`${defaultBaseUrl}/v1/customers`);
  expect(url.searchParams.get("email")).toBe(customer.email);
  expect(call!.headers.get("authorization")).toBe("Bearer test-crm-key");
});

// After a lookup in the same conversation, since the agent may enforce that order itself.
test("add_note posts the note with the mounted key", async () => {
  await bindMount();
  const fetch = stubFetch();
  await lookUpThenAddNote();

  const posts = (await requests(fetch)).filter((call) => call.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe(`${defaultBaseUrl}/v1/customers/${customer.id}/notes`);
  expect(posts[0]!.headers.get("authorization")).toBe("Bearer test-crm-key");
  expect(JSON.parse(posts[0]!.body)).toEqual({ note: "Prefers email." });
});

// In the package, so every agent that mounts it asks, and in this agent's compiled tool. The
// policy runs after a lookup, since it may also refuse notes for customers nobody looked up.
test("add_note always asks for approval", async () => {
  await bindMount();
  stubFetch();
  const session = new SessionState();
  await runTool(await loadTool("lookup_customer"), { email: customer.email }, session);
  const tool = await loadTool("add_note");
  const policy = typeof tool.approval === "function" ? tool.approval : tool.approval?.request;
  expect(typeof policy).toBe("function");
  for (const note of ["short", "x".repeat(500)]) {
    const toolInput = { customerId: customer.id, email: customer.email, note };
    const request = { callId: "call-1", session: graderSession, toolInput, toolName: "x" };
    const decision = await (
      await sessionStorage()
    ).run({ context: session }, () => policy(request));
    expect(requiresApproval(decision)).toBe(true);
  }
  const manifest = readJson(eveInfo().artifacts.compiledManifest);
  // oxlint-disable-next-line typescript/no-explicit-any -- the manifest is eve-internal.
  const compiled = manifest.tools.find((candidate: any) => candidate.name === mounted("add_note"));
  expect(compiled?.requiresApproval).toBe(true);
});

test("honors a configured key and base URL", async () => {
  const handle = await loadExtension();
  handle({ apiKey: "bound-key", baseUrl: "https://crm.internal.example" });
  const fetch = stubFetch();
  await lookUpThenAddNote();
  const calls = await requests(fetch);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(new Set(calls.map((call) => new URL(call.url).origin))).toEqual(
    new Set(["https://crm.internal.example"]),
  );
  // Another agent mounting the package with its own key gets that key, not this env's.
  expect(new Set(calls.map((call) => call.headers.get("authorization")))).toEqual(
    new Set(["Bearer bound-key"]),
  );
});

const customer = { id: "cus_1", email: "ada@example.com", name: "Ada Lovelace" };

/** One conversation: look the customer up, then add a note to their record. */
async function lookUpThenAddNote(): Promise<void> {
  const session = new SessionState();
  await runTool(await loadTool("lookup_customer"), { email: customer.email }, session);
  const input = { customerId: customer.id, email: customer.email, note: "Prefers email." };
  await runTool(await loadTool("add_note"), input, session);
}

/**
 * Whether add_note, given only an email, looks the customer up by it before it writes the note.
 * Binds the configuration through the extension's handle rather than the agent's mount: the
 * mount binds once, and later tests rely on it binding after the handle tests.
 */
async function addNoteLooksUpFirst(): Promise<boolean> {
  const fetch = stubFetch();
  try {
    (await loadExtension())({ apiKey: "test-crm-key" });
    await runTool(await loadTool("add_note"), { email: customer.email, note: "Prefers email." });
  } catch {
    return false;
  }
  const calls = await requests(fetch);
  const lookup = calls.findIndex(
    (call) =>
      call.method === "GET" && new URL(call.url).searchParams.get("email") === customer.email,
  );
  const post = calls.findIndex((call) => call.method === "POST");
  return lookup !== -1 && post > lookup;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded files are untyped.
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sourceRoot(): string {
  const source = readJson(`${packageRoot}/package.json`).eve?.extension?.source ?? "./extension";
  return join(packageRoot, source);
}

/** The extension's instruction sources: a flat `instructions.*` file, an `instructions/` directory, or both. */
function extensionInstructions(): string {
  const root = sourceRoot();
  const flat = ["instructions.md", "instructions.ts"].map((name) => join(root, name));
  const nested = existsSync(join(root, "instructions"))
    ? readdirSync(join(root, "instructions"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
    : [];
  return [...flat, ...nested]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
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
function eveInfo(): any {
  return JSON.parse(
    execFileSync("npx", ["eve", "info", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }),
  );
}

/**
 * The mounted package as the agent loads it: its built entry points, resolved through
 * the agent's own dependency, so the mount and the tools share one extension handle.
 */
function packageEntry(subpath: "." | "./tools"): string {
  const root = realpathSync(`node_modules/${packageName}`);
  const target = readJson(`${root}/package.json`).exports?.[subpath];
  const file = typeof target === "string" ? target : (target?.import ?? target?.default);
  if (typeof file !== "string") throw new Error(`${packageName} does not export ${subpath}.`);
  return pathToFileURL(resolve(root, file)).href;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function loadExtension(): Promise<any> {
  return (await import(packageEntry("."))).default;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function loadTool(name: string): Promise<any> {
  const tool = (await import(packageEntry("./tools")))[name];
  if (tool === undefined) throw new Error(`${packageName}/tools does not export ${name}.`);
  return tool;
}

/**
 * Evaluates the agent's mount, which binds the configuration the tools read. A cached
 * mount does not bind again, so tests that bind other values run after these.
 */
async function bindMount(): Promise<void> {
  const mount = await import(pathToFileURL(resolve(mountFile())).href);
  expect(mount.default).toBeDefined();
}

/** Answers like Acme: the customer for a lookup, the created note for a POST. */
function stubFetch() {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    new Request(input, init).method === "POST"
      ? Response.json({ id: "note_1", note: "Prefers email." }, { status: 201 })
      : Response.json(customer),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
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

/** The session eve hands tools and approval policies: one conversation, in its first turn. */
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

/** Imports an `eve` entry point as the authored modules resolve it, sharing their module instance. */
// oxlint-disable-next-line typescript/no-explicit-any -- eve's types aren't installed at the root.
async function importProjectEve(subpath: string): Promise<any> {
  const eveRoot = "node_modules/eve";
  const target = readJson(`${eveRoot}/package.json`).exports[subpath];
  return import(pathToFileURL(resolve(eveRoot, target.import ?? target.default)).href);
}
