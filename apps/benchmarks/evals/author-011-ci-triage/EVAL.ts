import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Each test grades one requirement from the prompt, independently of the others,
// so the share of passing tests is a partial score for the run.

const projectRoot = "mender";
const agentRoot = `${projectRoot}/agent`;
const webhookSecret = "test-webhook-secret";
const metricsUrl = "https://metrics.pinecone.dev/v1/agent-turns";
// `pnpm@9`, `pnpm@^9`, pnpm's `latest-9` dist-tag, or the official installer's `PNPM_VERSION=9…`.
const pnpm9Install = /pnpm@(?:[\^~]|latest-)?9(?!\d)|PNPM_VERSION=["']?9(?!\d)/;
// The prompt says "GitHub Actions checks fail", which any of the channel's CI hooks can serve.
const ciEvents = ["check_suite", "check_run", "workflow_run"] as const;
type CiEvent = (typeof ciEvents)[number];
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// Set before any authored module loads: a module may read credentials at import
// time, and the ESM cache keeps whatever it saw first.
beforeEach(() => {
  vi.stubEnv("GITHUB_APP_ID", "12345");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", webhookSecret);
  vi.stubEnv("METRICS_TOKEN", "test-metrics-token");
  // The channel fetches PR context from GitHub before dispatching and swallows
  // failures, so no test reaches the real API.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in the grader");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("creates an eve project for Mender", () => {
  const packageJson = projectPackageJson();
  expect(packageJson.dependencies?.eve).toBeTruthy();
  expect(instructionsSource()).toMatch(/Mender/);
  expect(instructionsSource()).toMatch(/\bCI\b|check|test/i);
});

test("typechecks and compiles without changing the CI build", { timeout: 600_000 }, () => {
  // CI deploys with `eve build`, which prepares the sandbox snapshot. Skipping that
  // preparation is a local-only build, not something to bake into the script.
  const build = projectPackageJson().scripts?.build ?? "";
  expect(build).toMatch(/\beve build\b/);
  expect(build).not.toMatch(/skip-sandbox-prewarm/);
  const env = { ...process.env };
  for (const name of ["VERCEL", "VERCEL_OIDC_TOKEN", "VERCEL_TOKEN"]) delete env[name];
  const run = (args: string[]) =>
    execFileSync("npm", args, { cwd: projectRoot, env, stdio: "pipe", timeout: 280_000 });
  run(["run", "typecheck"]);
  run(["exec", "--", "eve", "build", "--skip-sandbox-prewarm"]);
});

test("answers @mender comments through its own GitHub App", async () => {
  const source = readFileSync(githubChannelFile(), "utf8");
  expect(source).toMatch(/from\s+["']eve\/channels\/github["']/);
  expect(source).not.toMatch(/connectGitHubCredentials/);

  const asked = await deliver("issue_comment", comment("@mender why is the ledger build red?"));
  expect(asked.status).toBe(200);
  expect(asked.sends).toHaveLength(1);
  // Coupled to the GitHub channel's continuation-token format; update it if that changes.
  expect(String(asked.sends[0]!.continuationToken)).toMatch(/^repo:4242:issue:17$/);

  expect((await deliver("issue_comment", comment("Looks good to me."))).sends).toEqual([]);

  const forged = await deliver("issue_comment", comment("@mender hi"), "sha256=" + "0".repeat(64));
  expect(forged.status).toBe(401);
  expect(forged.sends).toEqual([]);
});

test("triages failed GitHub Actions checks on pull requests", async () => {
  // Grade every CI event the agent reacts to; at least one has to start a triage.
  const handled: CiEvent[] = [];
  for (const event of ciEvents) {
    const failed = await deliver(event, ciEvent(event, {}));
    if (failed.sends.length === 0) continue;
    handled.push(event);
    expect(failed.sends, event).toHaveLength(1);
    // The turn continues the PR thread, so its replies land on PR #31.
    expect(String(failed.sends[0]!.continuationToken)).toMatch(/^repo:4242:\w+:31$/);
  }
  expect(handled, "no CI event started a triage").not.toEqual([]);

  for (const event of handled) {
    const ignored = [
      ciEvent(event, { conclusion: "success" }),
      ciEvent(event, { action: pendingAction[event], conclusion: null, status: "queued" }),
    ];
    // `workflow_run` is GitHub Actions-only, so only check events can come from other CI apps.
    if (event !== "workflow_run")
      ignored.push(ciEvent(event, { app: { slug: "circleci-checks" } }));
    for (const payload of ignored) {
      expect((await deliver(event, payload)).sends, JSON.stringify(payload)).toEqual([]);
    }
  }
});

test("prepares Vercel Sandboxes with pnpm 9", async () => {
  const runtime = sandboxRuntime(await sandboxModule());
  expect(runtime.providerName).toBe("vercel");
  // Setup in `prepare` is captured once in the snapshot; setup after `open()` runs per session.
  expect(runtime.prepare).toBeTypeOf("function");
  const sandbox = recordingSandbox();
  await runtime.prepare(sandbox);
  expect(sandbox.commands.join("\n")).toMatch(pnpm9Install);
});

test("gives each sandbox 4 vCPUs", async () => {
  const module = await sandboxModule();
  const opened: unknown[] = [];
  module.environment.open = async (options: unknown) => {
    opened.push(options);
    return recordingSandbox();
  };
  await module.default({
    session: { auth: { current: null, initiator: null }, id: "session-1", turn: { id: "turn-1" } },
  });
  expect(opened).toHaveLength(1);
  // Either place works: session sandboxes get the environment's options, overridden by `open()`'s.
  const { prepare: _prepare, ...created } = environmentOptions ?? {};
  expect({ ...created, ...(opened[0] as object) }).toMatchObject({ resources: { vcpus: 4 } });
});

test("flake-hunter works in Mender's sandbox", async () => {
  const root = `${agentRoot}/subagents/flake-hunter`;
  const definition = await load(`${root}/agent.ts`);
  expect(definition?.description).toMatch(/\S/);
  const sandboxFile = [`${root}/sandbox.ts`, `${root}/sandbox/sandbox.ts`].find(existsSync);
  expect(sandboxFile).toBeDefined();
  const selector = await load(sandboxFile!);
  // What `defineParentSandbox()` marks its selector with.
  expect(selector?.[Symbol.for("eve.sandbox-parent-definition")]).toBe(true);
});

test("reports each finished turn to the metrics service", async () => {
  const fetch = vi.fn(
    async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetch);
  await settleTurn();

  const calls = await Promise.all(fetch.mock.calls.map(([input, init]) => request(input, init)));
  const reports = calls.filter((call) => call.url === metricsUrl);
  expect(reports).toHaveLength(1);
  const [report] = reports;
  expect(report!.method).toBe("POST");
  expect(report!.headers.get("authorization")).toBe("Bearer test-metrics-token");
  // Extra fields don't break the metrics service, so only the requested ones are graded.
  expect(JSON.parse(report!.body)).toMatchObject({
    sessionId: "session-1",
    turnId: "turn-1",
    outcome: "completed",
  });
});

// eve only logs a throwing `turn.settled` hook, so an outage can't fail the turn itself. What it
// can break is the rest of the turn's cleanup, such as a sandbox stop after the metrics call.
test("a metrics outage does not disrupt the rest of the turn's work", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 202 })),
  );
  const healthyStops = (await settleTurn()).sandbox.stops;

  const outages = [
    async () => {
      throw new TypeError("fetch failed");
    },
    async () => new Response("unavailable", { status: 503 }),
  ];
  for (const outage of outages) {
    const fetch = vi.fn(outage);
    vi.stubGlobal("fetch", fetch);
    const { sandbox } = await settleTurn();
    const urls = fetch.mock.calls.map(([input]) => new Request(input as RequestInfo).url);
    expect(urls).toContain(metricsUrl);
    expect(sandbox.stops).toBe(healthyStops);
  }
});

test("stops the sandbox when a turn finishes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 202 })),
  );
  const { sandbox } = await settleTurn();
  expect(sandbox.stops).toBeGreaterThan(0);
});

function projectPackageJson(): {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(`${projectRoot}/package.json`, "utf8"));
}

function instructionsSource(): string {
  for (const name of ["instructions.md", "instructions.ts"]) {
    const path = `${agentRoot}/${name}`;
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error("The agent has no root instructions.");
}

function sourceFiles(directory: string, pattern = /\.ts$/): string[] {
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

function githubChannelFile(): string {
  const [file, ...rest] = sourceFiles("channels").filter((path) =>
    /githubChannel\s*\(/.test(readFileSync(path, "utf8")),
  );
  expect(rest).toHaveLength(0);
  if (file === undefined) throw new Error("The agent has no GitHub channel.");
  return file;
}

/**
 * The GitHub channel's instrumentation kind, stamped on its definition the way eve's runtime
 * does when it loads the channel, so a hook that checks `isChannel(ctx.channel, github)`
 * recognizes the turn's channel. Without one GitHub channel, the hooks are still graded on
 * their own.
 */
async function githubChannelKind(): Promise<string> {
  let file: string;
  try {
    file = githubChannelFile();
  } catch {
    return "channel:github";
  }
  const kind = `channel:${file.slice(`${agentRoot}/channels/`.length).replace(/\.ts$/, "")}`;
  Object.defineProperty(await load(file), Symbol.for("eve.channel.instrumentationKind"), {
    configurable: true,
    enumerable: false,
    value: kind,
  });
  return kind;
}

interface Delivery {
  readonly status: number;
  readonly sends: ReadonlyArray<{ continuationToken: unknown; message: unknown }>;
}

async function deliver(event: string, payload: object, signature?: string): Promise<Delivery> {
  const channel = await load(githubChannelFile());
  const route = channel?.routes?.find(
    (candidate: { method?: string; path?: string }) =>
      candidate.method === "POST" && candidate.path === "/eve/v1/github",
  );
  expect(route).toBeDefined();
  const body = JSON.stringify(payload);
  const sends: Array<{ continuationToken: unknown; message: unknown }> = [];
  const pending: Array<Promise<unknown>> = [];
  const response: Response = await route.handler(
    new Request("https://mender.example.com/eve/v1/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": randomUUID(),
        "x-github-event": event,
        "x-hub-signature-256":
          signature ?? `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
      },
      body,
    }),
    {
      params: {},
      requestIp: "140.82.112.1",
      waitUntil: (task: Promise<unknown>) => pending.push(task),
      from: (continuationToken: unknown) => ({
        send: async (message: unknown) => {
          sends.push({ continuationToken, message });
          return { id: "session-1" };
        },
      }),
      to: () => ({
        send: async () => {
          throw new Error("GitHub deliveries should continue their own thread.");
        },
      }),
    },
  );
  await Promise.all(pending);
  return { status: response.status, sends };
}

function webhookBase() {
  return {
    installation: { id: 55 },
    repository: {
      full_name: "pinecone-labs/ledger",
      id: 4242,
      name: "ledger",
      owner: { login: "pinecone-labs" },
      private: true,
    },
    sender: { id: 7, login: "ada", type: "User" },
  };
}

function comment(body: string) {
  return {
    ...webhookBase(),
    action: "created",
    comment: { body, id: 9001, user: { id: 7, login: "ada", type: "User" } },
    issue: { number: 17 },
  };
}

/** The not-yet-finished action for each CI event. */
const pendingAction: Record<CiEvent, string> = {
  check_run: "created",
  check_suite: "requested",
  workflow_run: "in_progress",
};

function ciEvent(event: CiEvent, overrides: Record<string, unknown>) {
  const { action = "completed", ...fields } = overrides;
  return {
    ...webhookBase(),
    action,
    sender: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    [event]: {
      app: { slug: "github-actions" },
      conclusion: "failure",
      head_sha: "4f1c2e9d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e",
      id: 777001,
      pull_requests: [{ number: 31 }],
      status: "completed",
      ...fields,
    },
  };
}

/** Options passed to `VercelSandbox.environment()`; eve merges them under each `open()`'s. */
let environmentOptions: Record<string, unknown> | undefined;

async function sandboxModule() {
  const file = [`${agentRoot}/sandbox.ts`, `${agentRoot}/sandbox/sandbox.ts`].find(existsSync);
  if (file === undefined) throw new Error("The agent has no sandbox definition.");
  await recordVercelEnvironmentOptions();
  const module = await import(pathToFileURL(resolve(file)).href);
  expect(module.environment).toBeDefined();
  return module;
}

/** Wraps the project's own `VercelSandbox` before the authored sandbox module first loads. */
async function recordVercelEnvironmentOptions() {
  const { VercelSandbox } = await importProjectEve("./sandbox/vercel");
  if (VercelSandbox.environment.recording) return;
  const environment = VercelSandbox.environment.bind(VercelSandbox);
  VercelSandbox.environment = Object.assign(
    (options?: Record<string, unknown>) => {
      environmentOptions = options;
      return environment(options);
    },
    { recording: true },
  );
}

/** Imports an `eve` entry point as the authored modules resolve it, sharing their module instance. */
// oxlint-disable-next-line typescript/no-explicit-any -- eve's types aren't installed at the root.
async function importProjectEve(subpath: string): Promise<any> {
  const eveRoot = `${projectRoot}/node_modules/eve`;
  const target = JSON.parse(readFileSync(`${eveRoot}/package.json`, "utf8")).exports[subpath];
  return import(pathToFileURL(resolve(eveRoot, target.import ?? target.default)).href);
}

/** The session as of a GitHub turn that ran the test suite in the sandbox and settled. */
async function settledTurnView(): Promise<unknown> {
  const { emptySessionView, foldEvents } = await importProjectEve("./events");
  const facts = [
    { type: "session.started", data: {} },
    { type: "turn.started", data: { turnId: "turn-1", cause: { deliveryId: "d" }, follows: null } },
    { type: "model.requested", data: { runId: "run-1", owner: { turnId: "turn-1" } } },
    {
      type: "call.requested",
      data: {
        callId: "call-1",
        owner: { runId: "run-1" },
        capability: { kind: "tool", name: "bash" },
        input: { command: "pnpm vitest run" },
      },
    },
    { type: "call.started", data: { callId: "call-1" } },
    { type: "call.settled", data: { callId: "call-1", outcome: "completed", output: "1 failed" } },
    { type: "model.settled", data: { runId: "run-1", outcome: "completed" } },
    { type: "turn.settled", data: { turnId: "turn-1", outcome: "completed" } },
  ];
  const at = new Date().toISOString();
  return foldEvents(
    emptySessionView(),
    facts.map((fact, line) => ({ ...fact, meta: { position: { line, index: 0 }, at } })),
  );
}

// oxlint-disable-next-line typescript/no-explicit-any -- the runtime is eve-internal.
function sandboxRuntime(module: { environment: object }): any {
  // Where `VercelSandbox.environment()` keeps its provider name and authored `prepare`.
  return (module.environment as Record<symbol, unknown>)[
    Symbol.for("eve.sandbox-provider-runtime")
  ];
}

/** A sandbox that records the commands it runs and how often it was stopped. */
function recordingSandbox() {
  const commands: string[] = [];
  const execute = (input: string | { command: string }) => {
    const command = typeof input === "string" ? input : input.command;
    commands.push(command);
    // Answer version checks once pnpm 9 is installed, so a `prepare` that verifies its install passes.
    const installed = pnpm9Install.test(commands.join("\n"));
    // Some installs expose pnpm 9 under an alias such as `pnpm9`.
    const stdout =
      installed && /\bpnpm[\w.-]*\s+(?:--version|-v)\b/.test(command) ? "9.15.4\n" : "";
    return { exitCode: 0, stdout, stderr: "" };
  };
  const sandbox = {
    commands,
    stops: 0,
    name: "sandbox-1",
    resolvePath: (path: string) => `/workspace/${path}`,
    async run(input: string | { command: string }) {
      return execute(input);
    },
    async spawn(input: string | { command: string }) {
      const { exitCode, stdout, stderr } = execute(input);
      return {
        stdout: new Blob([stdout]).stream(),
        stderr: new Blob([stderr]).stream(),
        wait: async () => ({ exitCode }),
        kill: async () => {},
      };
    },
    async stop() {
      sandbox.stops += 1;
    },
    async setNetworkPolicy() {},
    async writeTextFile() {},
    async writeFiles() {},
    async readTextFile() {
      return "";
    },
  };
  return sandbox;
}

/** Runs every agent-wide `turn.settled` subscriber, as eve does after the turn is recorded. */
async function settleTurn() {
  const sandbox = recordingSandbox();
  const event = { type: "turn.settled", data: { turnId: "turn-1", outcome: "completed" } };
  const ctx = {
    agent: { name: "mender" },
    channel: { kind: await githubChannelKind() },
    session: { id: "session-1", auth: { current: null, initiator: null } },
    position: { line: 7, index: 0 },
    view: await settledTurnView(),
    turn: { id: "turn-1" },
    now: new Date(),
    occurrence: { idempotencyKey: "turn-1:settled", abortSignal: new AbortController().signal },
    memo: (_key: string, compute: () => unknown) => compute(),
    cancel: vi.fn(),
    getSandbox: async () => sandbox,
  };
  const handlers = [];
  // Agent-wide hooks, not channel `events`: the GitHub channel's own `turn.settled`
  // handler delivers failure replies, and an authored one would replace it.
  for (const file of sourceFiles("hooks")) {
    const events = (await load(file))?.events ?? {};
    handlers.push(...[events["turn.settled"], events["*"]].filter(Boolean));
  }
  expect(handlers.length).toBeGreaterThan(0);
  // Like eve, run each hook on its own and only log a failure, so one throwing hook can't
  // hide another hook's work.
  for (const handler of handlers) {
    try {
      await handler(event, ctx);
    } catch {}
  }
  return { sandbox };
}

async function request(input: unknown, init?: RequestInit) {
  const { url, method, headers, body } = new Request(input as RequestInfo, init);
  return { url, method, headers, body: body === null ? "" : await new Response(body).text() };
}
