import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Each test grades one requirement from the prompt, independently of the others,
// so the share of passing tests is a partial score for the run.

const projectRoot = "tally";
const agentRoot = `${projectRoot}/agent`;
const sessionSecret = "test-session-secret";
const cancelRoute = "/eve/v1/session/:sessionId/cancel";
const createRoute = "/eve/v1/session";
const MB = 1024 * 1024;

/** The demo accounts in Tally's `lib/users.ts`. */
const maya = { userId: "usr_maya", orgId: "org_brightside", role: "owner", name: "Maya Chen" };
const leo = { userId: "usr_leo", orgId: "org_brightside", role: "member", name: "Leo Park" };
const sam = { userId: "usr_sam", orgId: "org_harbor", role: "owner", name: "Sam Okafor" };
type User = typeof maya;

// Set before any authored module loads: a module may read configuration at import
// time, and the ESM cache keeps whatever it saw first. Route auth is graded as a
// production deployment, where `localDev()` admits nobody.
beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", sessionSecret);
  vi.stubEnv("NODE_ENV", "production");
  for (const name of [
    "EVE_DEV",
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_OIDC_TOKEN",
    "VERCEL_PROJECT_ID",
  ]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("adds an eve agent to the Tally app", () => {
  const packageJson = projectPackageJson();
  expect(packageJson.dependencies?.next).toBeTruthy();
  expect(packageJson.dependencies?.eve).toBeTruthy();
  expect(existsSync(`${agentRoot}/agent.ts`) || existsSync(`${agentRoot}/instructions.md`)).toBe(
    true,
  );
  expect(instructionsSource()).toMatch(/invoice/i);
});

test("typechecks, and both eve and Next.js build", { timeout: 900_000 }, () => {
  const env = { ...process.env, NODE_ENV: "production" };
  for (const name of ["VERCEL", "VERCEL_OIDC_TOKEN", "VERCEL_TOKEN"]) delete env[name];
  const run = (args: string[]) =>
    execFileSync("npm", args, { cwd: projectRoot, env, stdio: "pipe", timeout: 400_000 });
  run(["run", "typecheck"]);
  run(["exec", "--", "eve", "build"]);
  run(["run", "build"]);
});

test("runs and deploys the agent with the Next.js app through withEve", () => {
  const file = ["next.config.ts", "next.config.mjs", "next.config.js"]
    .map((name) => `${projectRoot}/${name}`)
    .find(existsSync);
  expect(file).toBeDefined();
  const source = readFileSync(file!, "utf8");
  expect(source).toMatch(/import\s*\{[^}]*\bwithEve\b[^}]*\}\s*from\s*["']eve\/next["']/);
  expect(source).toMatch(/export\s+default\s+withEve\s*\(/);
});

test("admits signed-in Tally users as themselves", async () => {
  for (const user of [maya, sam]) {
    const { status, auth } = await authenticate({ cookie: sessionCookie(user) });
    expect(status, user.userId).toBe(202);
    expect(auth?.principalType, user.userId).toBe("user");
    expect(String(auth?.principalId), user.userId).toContain(user.userId);
  }
});

test("turns away requests without a valid Tally session", async () => {
  const forged = sessionCookie(maya).replace(/\.[^.]+$/, ".forged-signature");
  const expired = sessionCookie(maya, { expiresAt: Date.now() - 60_000 });
  for (const [label, headers] of [
    ["no cookie", {}],
    ["forged cookie", { cookie: forged }],
    ["expired cookie", { cookie: expired }],
    ["unrelated cookie", { cookie: "theme=dark" }],
  ] as const) {
    const { status, auth } = await authenticate(headers);
    expect([401, 403], label).toContain(status);
    expect(auth, label).toBeUndefined();
  }
});

test("find_invoices lists only the caller's organization", async () => {
  const tool = await load(`${agentRoot}/tools/find_invoices.ts`);
  const find = async (user: User, input: Record<string, unknown>) => {
    const parsed = await parseInput(tool, input);
    expect(parsed.success, JSON.stringify(input)).toBe(true);
    return JSON.stringify(await tool.execute(parsed.data, await toolContext(user)));
  };
  const mentions = (output: string, number: number) =>
    output.includes(`INV-${number}`) || output.includes(`inv_${number}`);

  const brightside = await find(maya, {});
  expect(mentions(brightside, 1041)).toBe(true);
  expect(mentions(brightside, 1042)).toBe(true);
  expect(mentions(brightside, 2001)).toBe(false);

  const harbor = await find(sam, {});
  expect(mentions(harbor, 2001)).toBe(true);
  expect(mentions(harbor, 1041)).toBe(false);

  const overdue = await find(maya, { status: "overdue" });
  expect(mentions(overdue, 1041)).toBe(true);
  expect(mentions(overdue, 1042)).toBe(false);

  // The model controls tool input, so input naming another org must not reach it.
  for (const input of [{ orgId: "org_harbor" }, { organizationId: "org_harbor" }]) {
    const parsed = await parseInput(tool, input);
    if (!parsed.success) continue;
    const output = JSON.stringify(await tool.execute(parsed.data, await toolContext(maya)));
    expect(mentions(output, 2001), JSON.stringify(input)).toBe(false);
  }
});

test("send_reminder reminds clients only within the caller's organization", async () => {
  const tool = await load(`${agentRoot}/tools/send_reminder.ts`);
  const before = await reminderCount("org_brightside", "inv_1042");
  await tool.execute(await invoiceInput(tool, "inv_1042"), await toolContext(leo));
  expect(await reminderCount("org_brightside", "inv_1042")).toBe(before + 1);

  const harborBefore = await reminderCount("org_harbor", "inv_2001");
  await tool
    .execute(await invoiceInput(tool, "inv_2001"), await toolContext(maya))
    .catch(() => undefined);
  expect(await reminderCount("org_harbor", "inv_2001")).toBe(harborBefore);
});

test("asks an owner to confirm before voiding", async () => {
  const tool = await load(`${agentRoot}/tools/void_invoice.ts`);
  const input = await invoiceInput(tool, "inv_1044");
  expect(decision(await approve(tool, maya, input))).toBe("ask");

  // Once Maya approves, the call voids her org's draft.
  await tool.execute(input, await toolContext(maya));
  expect(await invoiceStatus("org_brightside", "inv_1044")).toBe("void");
});

test("never voids for members or across organizations", async () => {
  const tool = await load(`${agentRoot}/tools/void_invoice.ts`);
  const attempt = async (user: User, invoiceId: string) => {
    const input = await invoiceInput(tool, invoiceId);
    // A policy may refuse outright; otherwise the call has to refuse when it runs.
    if (decision(await approve(tool, user, input)) === "deny") return;
    await tool.execute(input, await toolContext(user)).catch(() => undefined);
  };

  await attempt(leo, "inv_1042");
  expect(await invoiceStatus("org_brightside", "inv_1042")).toBe("sent");
  await attempt(maya, "inv_2002");
  expect(await invoiceStatus("org_harbor", "inv_2002")).toBe("sent");
  // A tool that never voids anything would refuse both trivially.
  await attempt(maya, "inv_1041");
  expect(await invoiceStatus("org_brightside", "inv_1041")).toBe("void");
});

test("draft_invoice creates a draft in the caller's organization", async () => {
  const tool = await load(`${agentRoot}/tools/draft_invoice.ts`);
  const input = await firstParsed(tool, draftCandidates("Pinecrest Hotel"));
  await tool.execute(input, await toolContext(sam));
  const invoices = await import(moduleUrl(`${projectRoot}/lib/invoices.ts`));
  const drafts = await invoices.listInvoices("org_harbor", { client: "Pinecrest" });
  expect(drafts.map((invoice: { status: string }) => invoice.status)).toEqual(["draft"]);
  expect(await invoices.listInvoices("org_brightside", { client: "Pinecrest" })).toEqual([]);
});

test("accepts PDF attachments up to 3 MB and nothing else", async () => {
  const send = async (mediaType: string, bytes: number) =>
    (await createSession(sessionCookie(maya), mediaType, bytes)).status;

  expect([413, 415, 401, 403]).not.toContain(await send("application/pdf", 2.5 * 1_000_000));
  expect(await send("application/pdf", 3.5 * MB)).toBe(413);
  for (const mediaType of ["image/png", "text/csv", "application/zip"]) {
    expect(await send(mediaType, 20_000), mediaType).toBe(415);
  }
});

test("remembers preferences for each person, privately", async () => {
  const files = [
    ...(existsSync(`${agentRoot}/memory.ts`) ? [`${agentRoot}/memory.ts`] : []),
    ...sourceFiles("memory", /\.ts$/),
  ];
  expect(files.length).toBeGreaterThan(0);
  const scopes = await Promise.all(
    files.map(async (file) => {
      const slot = await load(file);
      expect(slot?.provider, file).toBeDefined();
      const scopeFor = async (user: User, sessionId: string) => {
        if (typeof slot.scope !== "function") return slot.scope;
        const { session } = await toolContext(user, sessionId);
        return slot.scope({
          session,
          channel: { kind: "http" },
          abortSignal: new AbortController().signal,
        });
      };
      return {
        mayaToday: JSON.stringify(await scopeFor(maya, "session-1")),
        mayaTomorrow: JSON.stringify(await scopeFor(maya, "session-2")),
        leo: JSON.stringify(await scopeFor(leo, "session-3")),
      };
    }),
  );
  // A personal slot follows one person across conversations and keeps colleagues apart.
  const personal = scopes.filter(
    (scope) =>
      scope.mayaToday !== undefined &&
      scope.mayaToday !== "null" &&
      scope.mayaToday === scope.mayaTomorrow &&
      scope.leo !== scope.mayaToday,
  );
  expect(personal.length).toBeGreaterThan(0);
});

test("shows a chat panel on every dashboard page", () => {
  const layout = `${projectRoot}/app/(dashboard)/layout.tsx`;
  const rendered = [layout, `${projectRoot}/app/layout.tsx`].map((file) => resolvedSource(file));
  expect(rendered.some((source) => /\buseEveAgent\s*\(/.test(source))).toBe(true);
  expect(panelSource()).toMatch(/from\s+["']eve\/react["']/);
});

test("lets people approve or deny voids from the panel", () => {
  expect(panelSource()).toMatch(/\.respond\s*\(|\brespond\s*\(\s*\[/);
  expect(panelSource()).toMatch(/\bopenInteractions\b|\binteraction(?:s|Id)?\b/);
});

test("stops a reply mid-way from the panel", () => {
  expect(panelSource()).toMatch(/\.cancel\s*\(|\bcancel\s*\(\s*\)/);
  expect(panelSource()).toMatch(/stop/i);
});

test("attaches PDFs from the panel", () => {
  const source = panelSource();
  expect(source).toMatch(/type\s*:\s*["']file["']/);
  expect(source).toMatch(/application\/pdf|\.pdf\b/);
});

test("sends the current page with each message without saving it to history", () => {
  // `clientContext` lasts one turn; text added to the message would stay in history.
  expect(panelSource()).toMatch(/\bclientContext\b/);
});

test("restores the conversation after a page reload", () => {
  const source = panelSource();
  expect(source).toMatch(/\bresume\s*:/);
  expect(source).toMatch(/\binitialSession\b/);
});

function projectPackageJson(): { dependencies?: Record<string, string> } {
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

/** The app's frontend sources, outside the agent, dependencies, and build output. */
function appSourceFiles(): string[] {
  const skipped = new Set(["node_modules", ".next", ".eve", ".output", ".vercel", "agent"]);
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) visit(path);
      } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(projectRoot);
  return files.sort();
}

/** Every frontend module that drives eve from React, joined with the modules it imports. */
function panelSource(): string {
  const panels = appSourceFiles().filter((file) =>
    /from\s+["']eve\/react["']/.test(readFileSync(file, "utf8")),
  );
  if (panels.length === 0) throw new Error("No frontend module imports eve/react.");
  const seen = new Set<string>();
  return panels.map((file) => resolvedSource(file, seen)).join("\n");
}

/** A module's source plus the project files it imports, so re-exports count. */
function resolvedSource(path: string, seen = new Set<string>()): string {
  if (seen.has(path) || !existsSync(path)) return "";
  seen.add(path);
  const source = readFileSync(path, "utf8");
  const imported = [...source.matchAll(/from\s+["']((?:\.{1,2}|@)\/[^"']+)["']/g)].map((match) => {
    const specifier = match[1]!.replace(/\.js$/, "");
    // `@/` is the usual Next.js alias for the app root.
    const base = specifier.startsWith("@/")
      ? join(projectRoot, specifier.slice(2))
      : join(dirname(path), specifier);
    return [base, ...[".ts", ".tsx", "/index.ts", "/index.tsx"].map((suffix) => base + suffix)]
      .filter((candidate) => /\.tsx?$/.test(candidate))
      .find(existsSync);
  });
  return [source, ...imported.map((file) => (file ? resolvedSource(file, seen) : ""))].join("\n");
}

function moduleUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(moduleUrl(path))).default;
}

/** A `tally_session` cookie for a demo user, signed the way Tally's login form signs it. */
function sessionCookie(user: User, overrides: { expiresAt?: number } = {}): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...user,
      email: `${user.userId}@example.com`,
      expiresAt: overrides.expiresAt ?? Date.now() + 3_600_000,
    }),
  ).toString("base64url");
  // The same HMAC as `lib/session.ts`, kept independent of any edits to it.
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `tally_session=${payload}.${signature}`;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function eveChannelRoute(path: string): Promise<any> {
  const channel = await load(`${agentRoot}/channels/eve.ts`);
  const route = channel?.routes?.find(
    (candidate: { method?: string; path?: string }) =>
      candidate.method === "POST" && candidate.path === path,
  );
  expect(route).toBeDefined();
  return route;
}

interface Authentication {
  readonly status: number;
  // oxlint-disable-next-line typescript/no-explicit-any -- the principal the channel resolved.
  readonly auth?: any;
}

/**
 * Sends a cancel request through the authored eve channel. The route authenticates
 * before it touches the session, and hands the resolved principal to the session.
 */
async function authenticate(headers: Record<string, string>): Promise<Authentication> {
  const route = await eveChannelRoute(cancelRoute);
  let auth: unknown;
  const response: Response = await route.handler(
    new Request("https://tally.example.com/eve/v1/session/session-1/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ turnId: null }),
    }),
    {
      params: { sessionId: "session-1" },
      attachSession: () => ({
        cancel: async (options: { auth: unknown }) => {
          auth = options.auth;
          return { sessionId: "session-1", deliveryId: "delivery-1", inbox: "accepted" };
        },
      }),
    },
  );
  return { status: response.status, auth };
}

/** Starts a session with one attachment. Past the upload policy, eve needs its runtime. */
async function createSession(cookie: string, mediaType: string, bytes: number) {
  const route = await eveChannelRoute(createRoute);
  const header = mediaType === "application/pdf" ? "%PDF-1.7\n" : "";
  const content = Buffer.alloc(Math.floor(bytes), 0x20);
  content.write(header);
  const response: Response = await route.handler(
    new Request("https://tally.example.com/eve/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        message: [
          { type: "text", text: "Please draft an invoice from this purchase order." },
          {
            type: "file",
            mediaType,
            filename: "purchase-order",
            data: `data:${mediaType};base64,${content.toString("base64")}`,
          },
        ],
      }),
    }),
    { params: {}, waitUntil: () => undefined },
  );
  return { status: response.status };
}

/**
 * The tool context for a demo user's turn. The caller is the principal the
 * authored channel resolves from the user's cookie, so tools see what eve
 * would give them; a broken channel falls back to a principal carrying
 * Tally's session fields, so tools are graded on their own.
 */
async function toolContext(user: User, sessionId = "session-1") {
  let current;
  try {
    current = (await authenticate({ cookie: sessionCookie(user) })).auth;
  } catch {
    current = undefined;
  }
  current ??= {
    authenticator: "tally",
    issuer: "tally",
    principalId: user.userId,
    principalType: "user",
    subject: user.userId,
    attributes: { ...user, email: `${user.userId}@example.com` },
  };
  return {
    session: { id: sessionId, auth: { current, initiator: current }, turn: { id: "turn-1" } },
    callId: "call-1",
    abortSignal: new AbortController().signal,
  };
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function approve(tool: any, user: User, input: unknown): Promise<unknown> {
  const policy = typeof tool.approval === "function" ? tool.approval : tool.approval?.request;
  if (typeof policy !== "function") return undefined;
  return policy({
    ...(await toolContext(user)),
    approvedTools: new Set(),
    toolInput: input,
    toolName: "void_invoice",
  });
}

function decision(status: unknown): "ask" | "deny" | "run" {
  const type =
    typeof status === "object" && status !== null && "type" in status ? status.type : status;
  if (type === true || type === "user-approval") return "ask";
  if (type === "denied") return "deny";
  return "run";
}

async function invoiceInput(tool: unknown, invoiceId: string) {
  const number = `INV-${invoiceId.slice(4)}`;
  const extras = {
    reason: "Issued twice by mistake.",
    note: "Friendly reminder.",
    tone: "friendly",
  };
  const bases = [
    { invoiceId },
    { invoice_id: invoiceId },
    { id: invoiceId },
    { invoiceNumber: number },
    { number },
  ];
  return firstParsed(
    tool,
    bases.flatMap((base) => [base, { ...base, ...extras }]),
  );
}

function draftCandidates(clientName: string): Record<string, unknown>[] {
  const common = { clientName, clientEmail: "ap@pinecrest.example", dueOn: "2026-12-15" };
  const item = { description: "Lobby wayfinding signage", quantity: 2 };
  return [
    { ...common, lineItems: [{ ...item, unitPriceCents: 125_000 }] },
    { ...common, lineItems: [{ ...item, unitPrice: 1250 }] },
    { ...common, lineItems: [{ ...item, unitPriceUsd: 1250 }] },
    { ...common, lineItems: [{ ...item, unitPriceDollars: 1250 }] },
    { ...common, lineItems: [{ ...item, amount: 1250 }] },
    { ...common, dueDate: common.dueOn, lineItems: [{ ...item, unitPriceCents: 125_000 }] },
    { ...common, dueDate: common.dueOn, lineItems: [{ ...item, unitPrice: 1250 }] },
  ];
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function firstParsed(tool: any, candidates: unknown[]): Promise<any> {
  for (const candidate of candidates) {
    const parsed = await parseInput(tool, candidate);
    if (parsed.success) return parsed.data;
  }
  throw new Error(`The ${tool?.name ?? "tool"} schema rejected every expected input shape.`);
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

async function invoiceStatus(orgId: string, invoiceId: string): Promise<string | undefined> {
  const invoices = await import(moduleUrl(`${projectRoot}/lib/invoices.ts`));
  return (await invoices.getInvoice(orgId, invoiceId))?.status;
}

async function reminderCount(orgId: string, invoiceId: string): Promise<number> {
  const invoices = await import(moduleUrl(`${projectRoot}/lib/invoices.ts`));
  return (await invoices.getInvoice(orgId, invoiceId))?.reminders.length ?? 0;
}
