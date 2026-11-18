import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Each test grades one requirement from the prompt, independently of the others,
// so the share of passing tests is a partial score for the run.

const projectRoot = "restock-agent";
const agentRoot = `${projectRoot}/agent`;
const apiBaseUrl = "https://api.northstar-fulfillment.com";
const webhookSecret = "test-webhook-secret";

// Set before any authored module loads: a module may read credentials at import
// time, and the ESM cache keeps whatever it saw first.
beforeEach(() => {
  vi.stubEnv("NORTHSTAR_API_TOKEN", "test-token");
  vi.stubEnv("NORTHSTAR_WEBHOOK_SECRET", webhookSecret);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("creates an eve project for Restock", () => {
  const packageJson = JSON.parse(readFileSync(`${projectRoot}/package.json`, "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(packageJson.dependencies?.eve).toBeTruthy();
  expect(packageJson.scripts?.build).toBe("eve build");
  expect(instructionsSource()).toMatch(/Restock/);
  expect(instructionsSource()).toMatch(/Northstar|warehouse|inventory/i);
});

test("the project typechecks and builds", { timeout: 600_000 }, () => {
  for (const script of ["typecheck", "build"]) {
    execFileSync("npm", ["run", script], { cwd: projectRoot, stdio: "pipe", timeout: 280_000 });
  }
});

test("talks to the team in Slack through the Vercel Connect connector", () => {
  const [channel, ...rest] = sourceFiles("channels").filter((file) =>
    /slackChannel\s*\(/.test(readFileSync(file, "utf8")),
  );
  expect(rest).toHaveLength(0);
  expect(channel).toBeDefined();
  const source = readFileSync(channel!, "utf8");
  expect(source).toMatch(/from\s+["']eve\/channels\/slack["']/);
  expect(source).toMatch(/connectSlackCredentials\s*\(\s*["']slack\/restock["']\s*\)/);
});

test("connects to the Northstar API from the bundled contract as the app", async () => {
  const connections = await northstarConnections();
  const runs = await customNorthstarToolRuns();
  expect(connections.length + runs.length).toBeGreaterThan(0);
  for (const { name, connection } of connections) {
    expect(connection.baseUrl ?? connection.spec?.servers?.[0]?.url, name).toBe(apiBaseUrl);
    // The contract has no public URL, so it has to travel with the project.
    expect(typeof connection.spec, name).toBe("object");
    expect(Object.keys(connection.spec.paths), name).toContain("/purchase-orders");

    const auth =
      typeof connection.auth === "function" ? await connection.auth({}) : connection.auth;
    expect(auth?.credentialOwner ?? "app", name).toBe("app");
    expect(await auth.getToken({}), name).toMatchObject({ token: "test-token" });
  }
  for (const { file, requests } of runs) {
    for (const request of requests) {
      expect(request.authorization, file).toBe("Bearer test-token");
    }
  }
});

test("exposes lookups and purchase orders but not stock adjustments", async () => {
  // The API may be split across connections, such as read-only lookups and purchasing.
  // An authored tool provides an operation only when it calls it as the contract
  // describes, and any other Northstar endpoint it reaches counts as exposed.
  const runs = await customNorthstarToolRuns();
  const visible = new Set([
    ...(await northstarConnections()).flatMap(({ connection }) =>
      northstarOperations.filter((operation) => exposes(connection, operation)),
    ),
    ...runs.filter(implementsProbe).map(({ probe }) => probe.operation),
    ...runs
      .flatMap(({ requests }) => requests.map(operationOf))
      .filter((operation) => !allowedOperations.includes(operation)),
  ]);
  expect([...visible].sort()).toEqual(allowedOperations);
});

test("asks a person to approve purchase orders of $5,000 or more", async () => {
  const connections = await northstarConnections();
  const runs = await customNorthstarToolRuns();
  const checkApproval = async (
    operation: string,
    input: Record<string, unknown>,
    expected: boolean,
  ) => {
    const owners = [
      ...connections
        .filter(({ connection }) => exposes(connection, operation))
        .map(({ name, connection }) => ({
          name: `${name}__${operation}`,
          approval: connection.approval,
          toolInput: input,
        })),
      ...runs
        .filter((run) => run.probe.operation === operation && sendsProbeRequest(run))
        // Grade each tool on the first input form it accepts and on any other form that
        // places the requested order, so every way it can place that order is covered.
        .filter(
          (run, index, sent) =>
            sent.findIndex(({ file }) => file === run.file) === index || implementsProbe(run),
        )
        .map(({ name, tool, nested }) => ({
          name,
          approval: tool.approval,
          toolInput: nested ? input : (input.body ?? input),
        })),
    ];
    expect(owners.length, operation).toBeGreaterThan(0);
    for (const { name, approval, toolInput } of owners) {
      const policy = typeof approval === "function" ? approval : approval?.request;
      const decision =
        policy === undefined
          ? false
          : await policy({
              approvedTools: new Set(),
              callId: "call-1",
              session: session(),
              toolInput,
              toolName: name,
            });
      expect(requiresApproval(decision), name).toBe(expected);
    }
  };
  const order = (quantity: number, unitCostUsd: number) => ({
    body: { sku: "NS-1042", quantity, unitCostUsd },
  });

  await checkApproval("createPurchaseOrder", order(100, 50), true);
  await checkApproval("createPurchaseOrder", order(1, 7200), true);
  await checkApproval("createPurchaseOrder", order(100, 49.99), false);
  await checkApproval("getStock", { sku: "NS-1042" }, false);
  await checkApproval("listLowStock", {}, false);

  // An approval decision covers one order, so a tool places only the order it was asked for.
  for (const { file, probe, requests } of runs) {
    const orders = requests.filter((request) => operationOf(request) === "createPurchaseOrder");
    if (orders.length === 0) continue;
    expect(probe.operation, `${file} placed an order`).toBe("createPurchaseOrder");
    expect(orders, `${file} placed more than one order`).toHaveLength(1);
  }
});

test("rejects low-stock alerts with a bad signature", async () => {
  const { route, calls, context, pending } = await webhookRoute();
  const body = JSON.stringify({ sku: "NS-1042", onHand: 3, parLevel: 40 });
  for (const signature of [undefined, "0".repeat(64), sign(`${body} `)]) {
    const response = await route.handler(alertRequest(body, signature), context);
    expect(response.status, String(signature)).toBe(401);
  }
  await Promise.all(pending);
  expect(calls).toEqual([]);
});

test("hands valid low-stock alerts to the restock Slack channel", async () => {
  const { route, calls, context, pending } = await webhookRoute();
  const slack = await load(slackChannelFile());
  const body = JSON.stringify({ sku: "NS-1042", onHand: 3, parLevel: 40 });
  const response = await route.handler(alertRequest(body, sign(body)), context);
  await Promise.all(pending);

  expect(response.status).toBeLessThan(300);
  const handoffs = calls.filter((call) => call.kind === "to");
  expect(handoffs).toHaveLength(1);
  expect(handoffs[0]!.channel).toBe(slack);
  expect(handoffs[0]!.target).toMatchObject({ channelId: "C0RESTOCK1" });
  expect(JSON.stringify(handoffs[0]!.message)).toContain("NS-1042");
});

test("shares one supplier memory across the team", async () => {
  const files = [
    ...(existsSync(`${agentRoot}/memory.ts`) ? [`${agentRoot}/memory.ts`] : []),
    ...sourceFiles("memory", /\.ts$/),
  ];
  const slots = await Promise.all(files.map((file) => load(file)));
  const scopes = await Promise.all(
    slots.map(async (slot) => {
      expect(slot?.provider).toBeDefined();
      const scopeFor = async (principalId: string) => {
        if (typeof slot.scope !== "function") return slot.scope;
        const caller = session(principalId);
        return slot.scope({ session: caller, channel: { kind: "slack" }, auth: caller.auth });
      };
      return [await scopeFor("slack:U01ADA"), await scopeFor("slack:U02GRACE")];
    }),
  );
  const shared = scopes.filter(
    ([first, second]) =>
      first !== null && first !== undefined && JSON.stringify(first) === JSON.stringify(second),
  );
  expect(shared.length).toBeGreaterThan(0);
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

interface NorthstarProbe {
  readonly operation: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly input: Record<string, unknown>;
}

const northstarProbes: readonly NorthstarProbe[] = [
  { operation: "getStock", method: "GET", path: "/stock/NS-1042", input: { sku: "NS-1042" } },
  { operation: "listLowStock", method: "GET", path: "/stock/low", input: { warehouse: "east" } },
  {
    operation: "createPurchaseOrder",
    method: "POST",
    path: "/purchase-orders",
    input: { sku: "NS-1042", quantity: 100, unitCostUsd: 49.99 },
  },
  {
    operation: "adjustStock",
    method: "POST",
    path: "/stock/NS-1042/adjust",
    input: { sku: "NS-1042", delta: 1, reason: "stock count" },
  },
];

const northstarOperations = northstarProbes.map(({ operation }) => operation);

const allowedOperations = ["createPurchaseOrder", "getStock", "listLowStock"];

interface NorthstarRequest {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | null;
  body: unknown;
}

/** One run of an authored tool with a probe's input, and the Northstar requests it made. */
interface NorthstarToolRun {
  readonly file: string;
  readonly name: string;
  // oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
  readonly tool: any;
  readonly nested: boolean;
  readonly probe: NorthstarProbe;
  readonly requests: readonly NorthstarRequest[];
  readonly error: unknown;
}

function sendsProbeRequest({ probe, requests }: NorthstarToolRun): boolean {
  return requests.some(({ method, url }) => method === probe.method && url.pathname === probe.path);
}

function implementsProbe({ error, probe, requests }: NorthstarToolRun): boolean {
  if (error !== undefined) return false;
  return requests.some(({ method, url, body }) => {
    if (method !== probe.method || url.pathname !== probe.path) return false;
    // `warehouse` is optional, so a tool may leave it out, but it must not change it.
    const warehouse = url.searchParams.get("warehouse");
    if (probe.operation === "listLowStock" && warehouse !== null && warehouse !== "east") {
      return false;
    }
    const sent = body as Record<string, unknown> | null | undefined;
    return (
      probe.method !== "POST" ||
      Object.entries(probe.input).every(([key, value]) => sent?.[key] === value)
    );
  });
}

function operationOf({ method, url }: NorthstarRequest): string {
  const probe = northstarProbes.find(
    (candidate) => candidate.method === method && candidate.path === url.pathname,
  );
  return probe?.operation ?? `${method} ${url.pathname}`;
}

/**
 * Run authored tools with each operation's input, without requiring operation IDs as
 * filenames. This records what each tool did, and each test grades only its own part.
 */
async function customNorthstarToolRuns(): Promise<NorthstarToolRun[]> {
  const files = sourceFiles("tools", /\.ts$/);
  if (files.length === 0) return [];
  const eveRoot = resolve(projectRoot, "node_modules/eve");
  const toolsEntry = JSON.parse(readFileSync(`${eveRoot}/package.json`, "utf8")).exports["./tools"];
  // Use eve's real normalizer for Standard Schema, Standard JSON Schema, and plain JSON Schema.
  const { toInputSchema } = await import(
    new URL(
      "../../tools/schema.js",
      pathToFileURL(resolve(eveRoot, toolsEntry.import ?? toolsEntry.default)),
    ).href
  );
  const runs: NorthstarToolRun[] = [];
  for (const file of files) {
    const tool = await load(file);
    if (typeof tool?.execute !== "function") continue;
    const name = relative(`${agentRoot}/tools`, file).replace(/\.ts$/, "").split(sep).join("-");
    const schema = toInputSchema(tool.inputSchema);
    for (const probe of northstarProbes) {
      for (const nested of [false, true]) {
        if (nested && probe.method !== "POST") continue;
        let input: Record<string, unknown> = probe.input;
        if (nested) {
          input = { body: probe.input };
          if (probe.operation === "adjustStock") {
            const { sku, ...body } = probe.input;
            input = { sku, body };
          }
        }
        const parsed = schema ? await schema["~standard"].validate(input) : { value: input };
        if (parsed.issues) continue;
        const requests: NorthstarRequest[] = [];
        const bodies: Promise<void>[] = [];
        vi.stubGlobal("fetch", async (resource: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(resource, init);
          const url = new URL(request.url);
          if (url.origin === apiBaseUrl) {
            // Record the request before any await, so a tool that doesn't wait for it is graded too.
            const recorded: NorthstarRequest = {
              method: request.method,
              url,
              authorization: request.headers.get("authorization"),
              body: undefined,
            };
            requests.push(recorded);
            if (request.method === "POST") {
              const body = request
                .clone()
                .json()
                .then(
                  (value: unknown) => void (recorded.body = value),
                  () => {},
                );
              bodies.push(body);
              await body;
            }
          }
          const stock = { sku: "NS-1042", onHand: 3, reserved: 1, parLevel: 40 };
          if (url.pathname === "/purchase-orders") {
            return Response.json({ id: "po-grader-1", status: "submitted" }, { status: 201 });
          }
          return Response.json(url.pathname === "/stock/low" ? [stock] : stock);
        });
        let error: unknown;
        try {
          await tool.execute(parsed.value, {
            session: { id: "app-session", auth: { current: null, initiator: null } },
            callId: "call-1",
            toolName: name,
            messages: [],
            abortSignal: new AbortController().signal,
          });
        } catch (caught) {
          error = caught;
        }
        await Promise.all(bodies);
        if (requests.length === 0) continue;
        runs.push({ file, name, tool, nested, probe, requests, error });
      }
    }
  }
  return runs;
}

/** The connections built from the Northstar contract; each file stem is a runtime name. */
// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function northstarConnections(): Promise<Array<{ name: string; connection: any }>> {
  const connections = [];
  for (const file of sourceFiles("connections", /\.ts$/)) {
    const connection = await load(file);
    if (connection?.spec?.paths?.["/purchase-orders"] || /northstar/i.test(file)) {
      connections.push({ name: basename(file, ".ts"), connection });
    }
  }
  return connections;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
function exposes(connection: any, operation: string): boolean {
  const { allow, block } = connection.operations ?? {};
  return allow ? allow.includes(operation) : !block?.includes(operation);
}

function slackChannelFile(): string {
  const file = sourceFiles("channels", /\.ts$/).find((path) =>
    /slackChannel\s*\(/.test(readFileSync(path, "utf8")),
  );
  if (file === undefined) throw new Error("The agent has no Slack channel.");
  return file;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}

function session(principalId = "slack:U01ADA") {
  return {
    // Distinct per person, so a per-conversation scope cannot pass as team-wide.
    id: `session-${principalId}`,
    auth: {
      current: {
        // What eve's Slack channel sets for the person who sent the message.
        authenticator: "slack-webhook",
        principalId,
        principalType: "user",
        subject: principalId,
        attributes: {},
      },
    },
  };
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

function sign(body: string): string {
  return createHmac("sha256", webhookSecret).update(body).digest("hex");
}

function alertRequest(body: string, signature: string | undefined): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== undefined) headers.set("x-northstar-signature", signature);
  return new Request("https://restock.example.com/webhooks/low-stock", {
    method: "POST",
    headers,
    body,
  });
}

interface WebhookCall {
  readonly kind: "to" | "from";
  readonly channel?: unknown;
  readonly target?: unknown;
  readonly address?: unknown;
  readonly message: unknown;
}

async function webhookRoute() {
  let route: { path: string; method: string; handler: Function } | undefined;
  for (const file of sourceFiles("channels", /\.ts$/)) {
    const channel = await load(file);
    route ??= channel?.routes?.find(
      (candidate: { method?: string; path?: string }) =>
        candidate.method === "POST" && candidate.path === "/webhooks/low-stock",
    );
  }
  expect(route).toBeDefined();
  const calls: WebhookCall[] = [];
  const pending: Array<Promise<unknown>> = [];
  const sent = { id: "session-1" };
  const context = {
    params: {},
    requestIp: "203.0.113.7",
    waitUntil: (task: Promise<unknown>) => pending.push(task),
    to: (channel: unknown, target: unknown) => ({
      send: async (message: unknown) => {
        calls.push({ kind: "to", channel, target, message });
        return sent;
      },
    }),
    from: (address: unknown) => ({
      send: async (message: unknown) => {
        calls.push({ kind: "from", address, message });
        return sent;
      },
    }),
  };
  return { route: route!, calls, context, pending };
}
