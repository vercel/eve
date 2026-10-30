import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const username = "ada";
const password = "correct horse battery staple";
const createRoute = "/eve/v1/session";
// The route option eve's dispatcher uses to start a session; stubbed to record the caller.
const sessionCreatorKey = "__eveRouteSessionCreator";

// Graded as a production deployment, where `localDev()` admits nobody. Set before any authored
// module loads: a module may read configuration at import time.
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_USERNAME", username);
  vi.stubEnv("APP_PASSWORD", password);
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
  vi.unstubAllEnvs();
});

test("adds a Next.js chat UI wired to the agent", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  expect({ ...packageJson.dependencies, ...packageJson.devDependencies }.next).toBeTruthy();
  const config = nextConfig();
  // `eve/next` wraps the Next.js config; with Vercel services, `eve/vercel` wraps `vercel.ts`.
  const wrapped = [config, "vercel.ts"].some(
    (path) => existsSync(path) && /withEve\s*\(/.test(readFileSync(path, "utf8")),
  );
  expect(wrapped).toBe(true);
  const root = dirname(config);
  const ui = ["app", "src/app", "components", "src/components"]
    .flatMap((dir) => files(join(root, dir)))
    .filter((path) => /\.[jt]sx?$/.test(path));
  // eve's React hook, its client, or the HTTP API directly.
  expect(
    ui.some((path) =>
      /useEveAgent\s*\(|from\s+["']eve\/(?:react|client)["']|\/eve\/v1\//.test(
        readFileSync(path, "utf8"),
      ),
    ),
  ).toBe(true);
});

test("the agent API admits only the configured username and password", async () => {
  expect(await createSession(basic(username, password))).toBe(true);
  expect(await createSession(basic(username, "wrong password"))).toBe(false);
  expect(await createSession(basic("mallory", password))).toBe(false);
  expect(await createSession({})).toBe(false);
});

test("the agent API admits nobody when the credentials aren't configured", async () => {
  vi.stubEnv("APP_PASSWORD", undefined);
  // A module may read the credentials when it loads, so load it again without them.
  vi.resetModules();
  expect(await createSession(basic(username, password))).toBe(false);
  expect(await createSession(basic(username, ""))).toBe(false);
});

test("the chat page asks for the username and password", async () => {
  const guard = await routeGuard();
  const denied = await guard(new Request("https://chat.example.com/"));
  expect(denied?.status).toBe(401);
  const wrong = await guard(
    new Request("https://chat.example.com/", { headers: basic(username, "wrong password") }),
  );
  expect(wrong?.status).toBe(401);
  const allowed = await guard(
    new Request("https://chat.example.com/", { headers: basic(username, password) }),
  );
  expect(allowed?.status ?? 200).not.toBe(401);
});

function basic(user: string, pass: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
}

/** Starts a session through the authored eve channel; true when it got through auth. */
async function createSession(headers: Record<string, string>): Promise<boolean> {
  const channel = await load("agent/channels/eve.ts");
  const route = channel?.routes?.find(
    (candidate: { method?: string; path?: string }) =>
      candidate.method === "POST" && candidate.path === createRoute,
  );
  expect(route).toBeDefined();
  let auth: unknown;
  const response: Response = await route.handler(
    new Request(`https://chat.example.com${createRoute}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ message: [{ type: "text", text: "Hello" }] }),
    }),
    {
      params: {},
      waitUntil: () => undefined,
      [sessionCreatorKey]: async (options: { auth: unknown }) => {
        auth = options.auth;
        return { sessionId: "session-1", deliveryId: "delivery-1" };
      },
    },
  );
  return response.status < 400 && auth != null;
}

/** The Next.js proxy (or older middleware) that guards the UI routes. */
async function routeGuard(): Promise<(request: Request) => Promise<Response | undefined>> {
  const root = dirname(nextConfig());
  const file = ["proxy", "middleware"]
    .flatMap((name) => [`${name}.ts`, `src/${name}.ts`, `${name}.js`, `src/${name}.js`])
    .map((path) => join(root, path))
    .find((path) => existsSync(path));
  expect(file).toBeDefined();
  const module = await import(pathToFileURL(resolve(file!)).href);
  const handler = module.proxy ?? module.middleware ?? module.default;
  expect(typeof handler).toBe("function");
  const { NextRequest } = await import(
    pathToFileURL(resolve("node_modules/next/dist/server/web/exports/index.js")).href
  );
  return async (request) => handler(new NextRequest(request), { waitUntil: () => undefined });
}

/** The Next.js app's config, at the project root or in a nested app such as `apps/web`. */
function nextConfig(): string {
  const config = files(".")
    .filter((path) => /(?:^|\/)next\.config\.(?:ts|mjs|js)$/.test(path))
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  expect(config).toBeDefined();
  return config!;
}

/** Project files under a directory, skipping installed packages and build output. */
function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = root === "." ? entry.name : join(root, entry.name);
    if (entry.isDirectory()) {
      return /^(?:node_modules|\.next|\.eve|\.output|\.git)$/.test(entry.name) ? [] : files(path);
    }
    return entry.isFile() ? [path] : [];
  });
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}
