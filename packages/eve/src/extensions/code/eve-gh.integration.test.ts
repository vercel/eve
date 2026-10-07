import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";

// The eve-gh child has no template: its prepared artifact is always `{}`.
vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => ({})),
}));

/**
 * Drives the built-in code extension's eve-gh child through eve's real
 * sandbox access lifecycle: the eve-gh bash tool authorizes the caller, the
 * child's selector opens the eve-gh provider, the real Vercel SDK talks to an
 * in-memory API, and persisted provider state resumes in a later access.
 */
const user = { principalId: "alice", principalType: "user", issuer: "slack:T" } as const;
const api = vercelApi();
let modules: Awaited<ReturnType<typeof load>>;

async function load() {
  (globalThis as Record<symbol, unknown>)[Symbol.for("eve.ext-config-scope")] =
    "eve-gh-integration";
  // Devbox requests use the global fetch captured when the provider is built.
  vi.stubGlobal("fetch", api.fetch);
  const extension = (await import("./extension/extension.ts")).default;
  const sandbox = await import("./extension/subagents/eve_gh/sandbox.ts");
  const bash = (await import("./extension/subagents/eve_gh/tools/bash.ts")).default;
  return { extension, sandbox, bash };
}

beforeAll(async () => {
  modules = await load();
  modules.extension({
    eveGh: {
      enabled: true,
      auth: { principalType: "user", getToken: async () => ({ token: "unused" }) } as never,
      resolveOptions: () => ({
        repository: "https://github.com/vercel/internal-agents",
        revision: "test-revision",
        teamId: "team_test",
        projectId: "prj_test",
      }),
    },
  });
});

afterEach(async () => {
  await shutdownActiveSandboxHandles();
});

function registry(): RuntimeSandboxRegistry {
  return {
    sandbox: {
      definition: {
        environment: modules.sandbox.environment as never,
        kind: "independent",
        logicalPath: "subagents/eve_gh/sandbox.ts",
        selector: modules.sandbox.default,
        revisionHash: "hash",
        sourceId: "eve_gh/sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
}

async function inSession<T>(
  sessionId: string,
  state: Parameters<typeof ensureSandboxAccess>[0]["state"],
  body: (input: {
    access: Awaited<ReturnType<typeof ensureSandboxAccess>>;
    runBash: (command: string) => Promise<unknown>;
  }) => Promise<T>,
): Promise<T> {
  const context = new ContextContainer();
  context.set(SessionKey, {
    auth: { current: user, initiator: user },
    sessionId,
    turn: { id: "turn", sequence: 1 },
  } as never);
  return await contextStorage.run(context, async () => {
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "eve_gh",
      registry: registry(),
      sessionId,
      state,
    });
    const ctx = {
      session: { id: sessionId, auth: { current: user, initiator: user } },
      abortSignal: new AbortController().signal,
      getToken: async () => ({ token: "user-token" }),
      requireAuth: () => {
        throw new Error("consent required");
      },
      getSandbox: async () => {
        const sandbox = await access.get();
        if (sandbox === null) throw new Error("no sandbox");
        return sandbox;
      },
    };
    const runBash = (command: string) =>
      Promise.resolve(modules.bash.execute({ command } as never, ctx as never));
    return await body({ access, runBash });
  });
}

it("creates, resumes, and deletes an eve-gh sandbox through the eve-gh tool", async () => {
  api.reset();
  const state = await inSession("session-a", null, async ({ access, runBash }) => {
    await runBash("pwd");
    const captured = await access.captureState();
    await access.stop();
    return captured;
  });

  expect(state.session?.providerName).toBe("eve-gh");
  expect(state.session?.state).toMatchObject({ devboxId: "devbox_owner", version: 3 });
  const creates = api.calls.filter((call) => call.kind === "create");
  expect(creates).toHaveLength(1);
  expect(creates[0]!.authorization).toBe("Bearer user-token");
  expect(creates[0]!.body).toMatchObject({
    source: {
      type: "git",
      url: "https://github.com/vercel/internal-agents",
      revision: "test-revision",
      credentials: true,
    },
    commitAs: { name: "Alice", email: "alice@example.com" },
  });
  expect(api.commandEnv().GH_TOKEN).toBe("owner-github");

  // A later access resumes the persisted provider state: no second Git grant.
  api.calls.length = 0;
  await inSession("session-a", state, async ({ access, runBash }) => {
    await runBash("pwd");
    expect(await access.captureState()).toEqual(state);
    await access.delete!();
  });
  expect(api.calls.filter((call) => call.kind === "create")).toHaveLength(0);
  expect(api.calls.find((call) => call.kind === "setup")?.body).toMatchObject({
    devboxId: "devbox_owner",
  });
  const teardown = api.calls
    .filter((call) => call.kind === "revoke" || call.kind === "delete")
    .map((call) => call.kind);
  expect(teardown).toEqual(["revoke", "delete"]);
  expect(api.exists()).toBe(false);
});

it("a failed fresh start leaves neither compute nor registration, and nothing persisted", async () => {
  api.reset();
  api.failRegister = true;
  await inSession("session-b", null, async ({ access, runBash }) => {
    await expect(runBash("pwd")).rejects.toThrow("Devbox credential request failed (403).");
    expect(await access.captureState()).toEqual({ session: null });
  });
  expect(api.calls.filter((call) => call.kind === "create")).toHaveLength(1);
  expect(api.calls.some((call) => call.kind === "revoke")).toBe(true);
  expect(api.exists()).toBe(false);
});

it("a failed resume keeps the sandbox and registration for the next attempt", async () => {
  api.reset();
  const state = await inSession("session-c", null, async ({ access, runBash }) => {
    await runBash("pwd");
    const captured = await access.captureState();
    await access.stop();
    return captured;
  });
  api.calls.length = 0;
  api.failRegister = true;
  await inSession("session-c", state, async ({ access, runBash }) => {
    await expect(runBash("pwd")).rejects.toThrow("Devbox credential request failed (403).");
    expect(await access.captureState()).toEqual(state);
  });
  expect(api.calls.some((call) => call.kind === "revoke" || call.kind === "delete")).toBe(false);
  expect(api.exists()).toBe(true);
});

function vercelApi() {
  type Call = {
    kind: "create" | "setup" | "register" | "revoke" | "delete" | "other";
    authorization: string | null;
    body?: Record<string, unknown>;
  };
  const calls: Call[] = [];
  const envs: Record<string, string>[] = [];
  const session = {
    id: "session_test",
    memory: 2048,
    vcpus: 2,
    region: "iad1",
    runtime: "node24",
    timeout: 120_000,
    status: "running",
    requestedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    cwd: "/workspace",
  };
  let name: string | undefined;
  let alive = false;
  let lastCommand: Record<string, unknown> = {};
  const state = { failRegister: false };
  const sandbox = () => ({
    name,
    persistent: true,
    createdAt: 1,
    updatedAt: 1,
    currentSessionId: session.id,
    status: "running",
    statusUpdatedAt: 1,
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    const text = request.method === "GET" ? "" : await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    const authorization = request.headers.get("authorization");
    const record = (kind: Call["kind"]) => calls.push({ kind, authorization, body });
    if (path === "/login/oauth/userinfo") {
      return Response.json({
        sub: "vercel-alice",
        name: "Alice",
        preferred_username: "alice",
        email: "alice@example.com",
      });
    }
    if (path === "/v1/devbox/setup") {
      record("setup");
      return Response.json({ id: "devbox_owner", registrationToken: "single-use" });
    }
    if (path === "/v1/devbox/register") {
      record("register");
      if (state.failRegister) return new Response("PRIVATE", { status: 403 });
      return Response.json({ vercelToken: "owner-vercel", gitOauthToken: "owner-github" });
    }
    if (path === "/v1/devbox/devbox_owner" && request.method === "DELETE") {
      record("revoke");
      return Response.json({});
    }
    const named = /^\/v2\/sandboxes\/([^/]+)$/.exec(path);
    if (request.method === "GET" && named) {
      return alive && named[1] === name
        ? Response.json({ sandbox: sandbox(), session, routes: [] })
        : Response.json({ error: { message: "Not found" } }, { status: 404 });
    }
    if (request.method === "POST" && /^\/v[23]\/sandboxes$/.test(path)) {
      record("create");
      alive = true;
      name = body?.name as string;
      return Response.json({ sandbox: sandbox(), session, routes: [] });
    }
    if (request.method === "DELETE" && named) {
      record("delete");
      alive = false;
      return Response.json({ sandbox: sandbox() });
    }
    if (request.method === "POST" && path.endsWith("/stop")) {
      return Response.json({ session: { ...session, status: "stopped" } });
    }
    if (path.endsWith("/cmd")) {
      if (body?.env) envs.push(body.env as Record<string, string>);
      const command = {
        id: "cmd_test",
        sessionId: session.id,
        name: body?.command,
        args: body?.args,
        cwd: "/workspace",
        startedAt: 1,
        exitCode: 0,
      };
      lastCommand = command;
      if (body?.wait !== true) return Response.json({ command: { ...command, exitCode: null } });
      return new Response(`${JSON.stringify({ command })}\n${JSON.stringify({ command })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    record("other");
    if (path.endsWith("/logs")) {
      return new Response("", { headers: { "content-type": "application/x-ndjson" } });
    }
    if (/\/cmd\/[^/]+$/.test(path)) {
      return Response.json({ command: lastCommand });
    }
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  };
  return {
    fetch,
    calls,
    commandEnv: () => Object.assign({}, ...envs) as Record<string, string>,
    exists: () => alive,
    reset() {
      calls.length = 0;
      envs.length = 0;
      alive = false;
      name = undefined;
      state.failRegister = false;
    },
    set failRegister(value: boolean) {
      state.failRegister = value;
    },
  };
}
