import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const secretStore = vi.hoisted(() => new Map<string, string>());
vi.mock("#compiled/just-secrets/index.js", () => ({
  secrets: {
    get: async ({ name }: { name: string }) => secretStore.get(name) ?? null,
    set: async ({ name, value }: { name: string; value: string }) => {
      secretStore.set(name, value);
    },
  },
}));

const TOKEN_URL = "https://api.vercel.com/login/oauth/token";

function fakeVercel() {
  let issued = 0;
  let liveRefresh = "";
  let liveAccess = "";
  const state = { refreshes: 0, invalidGrants: 0 };
  const issue = () => {
    issued += 1;
    liveRefresh = `refresh-${issued}`;
    liveAccess = `access-${issued}`;
    return { access_token: liveAccess, refresh_token: liveRefresh, expires_in: 3600 };
  };
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json({
        device_authorization_endpoint: "https://api.vercel.com/login/oauth/device-authorization",
        token_endpoint: TOKEN_URL,
      });
    if (url === TOKEN_URL) {
      state.refreshes += 1;
      const body = init?.body as URLSearchParams;
      if (body.get("refresh_token") !== liveRefresh) {
        state.invalidGrants += 1;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json(issue());
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { state, fetch, issue, accepts: (token: string) => token === liveAccess };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "eve-vercel-session-"));
  vi.stubEnv("HOME", home);
  secretStore.clear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

type EveProcess = typeof import("./store.js") & typeof import("./vercel.js");

async function startProcess(): Promise<EveProcess> {
  vi.resetModules();
  const store = await import("./store.js");
  const vercel = await import("./vercel.js");
  return { ...store, ...vercel };
}

it("shares one login across processes without refreshing it once per process", async () => {
  const vercel = fakeVercel();
  vi.stubGlobal("fetch", vercel.fetch);
  const processes: EveProcess[] = [];
  for (let index = 0; index < 4; index += 1) processes.push(await startProcess());
  const login = vercel.issue();
  await processes[0]!.writeVercelSession(
    {
      accessToken: login.access_token,
      refreshToken: login.refresh_token,
      expiresAt: Date.now() + 3_600_000,
      teamId: "team_a",
      teamName: "Alice",
    },
    processes[0]!.VERCEL_MODEL_CLIENT_ID,
  );

  // Each process makes model calls; a token the gateway rejects is refreshed, as
  // resolveGatewayModelCredential does after a 401.
  const call = async (instance: EveProcess) => {
    let session = await instance.resolveVercelSession();
    for (let attempt = 0; attempt < 3 && !vercel.accepts(session.accessToken); attempt += 1)
      session = await instance.resolveVercelSession(session.accessToken);
    return vercel.accepts(session.accessToken);
  };
  const results = [];
  for (let round = 0; round < 3; round += 1)
    results.push(...(await Promise.all(processes.map(call))));
  expect(results.every(Boolean)).toBe(true);
  expect(vercel.state.invalidGrants).toBe(0);
  expect(vercel.state.refreshes).toBe(0);
});

it("refreshes an expiring login once for every process", async () => {
  const vercel = fakeVercel();
  vi.stubGlobal("fetch", vercel.fetch);
  const processes: EveProcess[] = [];
  for (let index = 0; index < 4; index += 1) processes.push(await startProcess());
  const login = vercel.issue();
  await processes[0]!.writeVercelSession(
    {
      accessToken: login.access_token,
      refreshToken: login.refresh_token,
      expiresAt: Date.now() + 30_000,
      teamId: "team_a",
      teamName: "Alice",
    },
    processes[0]!.VERCEL_MODEL_CLIENT_ID,
  );
  const sessions = await Promise.all(processes.map((p) => p.resolveVercelSession()));
  expect(new Set(sessions.map((s) => s.accessToken)).size).toBe(1);
  expect(vercel.accepts(sessions[0]!.accessToken)).toBe(true);
  expect(vercel.state.refreshes).toBe(1);
});
