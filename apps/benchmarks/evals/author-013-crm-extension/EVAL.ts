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

test("gives the agent both tools and the extension's instructions", () => {
  const info = eveInfo();
  expect(info.status).toBe("ready");
  expect(info.tools).toEqual(
    expect.arrayContaining([mounted("lookup_customer"), mounted("add_note")]),
  );
  expect(info.tools).not.toContain("lookup_customer");
  expect(info.tools).not.toContain("add_note");
  // The extension contributes its own fragment beside the agent's instructions.
  expect(info.instructions).toContain(`instructions/${mount().namespace}`);
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
  const fetch = stubFetch({ id: "cus_1", email: "ada@example.com" });
  const tool = await loadTool("lookup_customer");
  const output = await tool.execute(parse(tool, { email: "ada@example.com" }), {});

  expect(output).toMatchObject({ id: "cus_1" });
  const [call] = await requests(fetch);
  const url = new URL(call!.url);
  expect(call!.method).toBe("GET");
  expect(url.origin + url.pathname).toBe(`${defaultBaseUrl}/v1/customers`);
  expect(url.searchParams.get("email")).toBe("ada@example.com");
  expect(call!.headers.get("authorization")).toBe("Bearer test-crm-key");
});

test("add_note posts the note with the mounted key", async () => {
  await bindMount();
  const fetch = stubFetch({ id: "note_1" });
  const tool = await loadTool("add_note");
  await tool.execute(parse(tool, { customerId: "cus_1", note: "Prefers email." }), {});

  const [call] = await requests(fetch);
  expect(call!.method).toBe("POST");
  expect(call!.url).toBe(`${defaultBaseUrl}/v1/customers/cus_1/notes`);
  expect(call!.headers.get("authorization")).toBe("Bearer test-crm-key");
  expect(JSON.parse(call!.body)).toEqual({ note: "Prefers email." });
});

// In the package, so every agent that mounts it asks, and in this agent's compiled tool.
test("add_note always asks for approval", async () => {
  const tool = await loadTool("add_note");
  const policy = typeof tool.approval === "function" ? tool.approval : tool.approval?.request;
  expect(typeof policy).toBe("function");
  for (const toolInput of [
    { customerId: "cus_1", note: "short" },
    { customerId: "cus_2", note: "x".repeat(500) },
  ]) {
    const decision = await policy({ callId: "call-1", session: {}, toolInput, toolName: "x" });
    expect(requiresApproval(decision)).toBe(true);
  }
  const manifest = readJson(eveInfo().artifacts.compiledManifest);
  // oxlint-disable-next-line typescript/no-explicit-any -- the manifest is eve-internal.
  const compiled = manifest.tools.find((candidate: any) => candidate.name === mounted("add_note"));
  expect(compiled?.requiresApproval).toBe(true);
});

test("honors a configured base URL", async () => {
  const handle = await loadExtension();
  handle({ apiKey: "test-crm-key", baseUrl: "https://crm.internal.example" });
  const fetch = stubFetch({ id: "cus_1" });
  const lookup = await loadTool("lookup_customer");
  await lookup.execute(parse(lookup, { email: "ada@example.com" }), {});
  const addNote = await loadTool("add_note");
  await addNote.execute(parse(addNote, { customerId: "cus_1", note: "Prefers email." }), {});
  const origins = (await requests(fetch)).map((call) => new URL(call.url).origin);
  expect(origins).toEqual(["https://crm.internal.example", "https://crm.internal.example"]);
});

// oxlint-disable-next-line typescript/no-explicit-any -- graded files are untyped.
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sourceRoot(): string {
  const source = readJson(`${packageRoot}/package.json`).eve?.extension?.source ?? "./extension";
  return join(packageRoot, source);
}

function extensionInstructions(): string {
  for (const name of ["instructions.md", "instructions.ts"]) {
    const path = `${sourceRoot()}/${name}`;
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return "";
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

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
function parse(tool: any, input: unknown): unknown {
  return tool.inputSchema?.parse ? tool.inputSchema.parse(input) : input;
}

function stubFetch(body: unknown) {
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);
  return fetch;
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
