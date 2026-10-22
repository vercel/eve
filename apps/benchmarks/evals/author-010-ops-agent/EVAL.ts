import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
  expect(connections.length).toBeGreaterThan(0);
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
});

test("exposes lookups and purchase orders but not stock adjustments", async () => {
  // The API may be split across connections, such as read-only lookups and purchasing.
  const visible = new Set(
    (await northstarConnections()).flatMap(({ connection }) =>
      northstarOperations.filter((operation) => exposes(connection, operation)),
    ),
  );
  expect([...visible].sort()).toEqual(["createPurchaseOrder", "getStock", "listLowStock"]);
});

test("asks a person to approve purchase orders of $5,000 or more", async () => {
  const connections = await northstarConnections();
  // Connection tools reach the policy as `<connection>__<operation>`, with the
  // JSON request body under `body`. Each operation goes to the connection that exposes it.
  const needsApproval = async (operation: string, toolInput: Record<string, unknown>) => {
    const owner = connections.find(({ connection }) => exposes(connection, operation));
    expect(owner, operation).toBeDefined();
    const { name, connection } = owner!;
    const policy =
      typeof connection.approval === "function"
        ? connection.approval
        : connection.approval?.request;
    if (policy === undefined) return false;
    return requiresApproval(
      await policy({
        approvedTools: new Set(),
        callId: "call-1",
        session: session(),
        toolInput,
        toolName: `${name}__${operation}`,
      }),
    );
  };
  const order = (quantity: number, unitCostUsd: number) => ({
    body: { sku: "NS-1042", quantity, unitCostUsd },
  });

  expect(await needsApproval("createPurchaseOrder", order(100, 50))).toBe(true);
  expect(await needsApproval("createPurchaseOrder", order(1, 7200))).toBe(true);
  expect(await needsApproval("createPurchaseOrder", order(100, 49.99))).toBe(false);
  expect(await needsApproval("getStock", { sku: "NS-1042" })).toBe(false);
  expect(await needsApproval("listLowStock", {})).toBe(false);
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

const northstarOperations = ["getStock", "listLowStock", "createPurchaseOrder", "adjustStock"];

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
