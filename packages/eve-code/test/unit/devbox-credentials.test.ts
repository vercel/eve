import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { SandboxSession } from "eve/sandbox";
import type { SandboxProviderHandle } from "eve/sandbox/provider";

import { withDevboxCredentials } from "../../extension/lib/devbox-credentials.ts";
import type { EveGhImplementation, EveGhSessionState } from "../../extension/lib/eve-gh-sandbox.ts";

const context = {
  host: {} as never,
  session: {
    auth: { current: null, initiator: null },
    id: "logical-session",
    turn: { id: "turn", sequence: 0 },
  },
  storagePath: "/unused",
};
const auth = { token: "user-oauth", teamId: "team_user", projectId: "prj_v" };
const started: EveGhSessionState = { sandboxName: "actual-sandbox-name", version: 3 };

function fixture() {
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const lifecycle: string[] = [];
  const commands: { command: string; env?: Record<string, string> }[] = [];
  const resumedWith: unknown[] = [];
  let credentials: Record<string, unknown> = {
    vercelToken: "owner-vercel",
    gitOauthToken: "owner-github",
    gitToken: "installation-token-must-not-be-used",
    env: { UNRELATED_SECRET: "not-forwarded" },
    sessionToken: "not-forwarded-either",
  };
  let failure: { path: string; status: number } | undefined;
  let deleteFailure: Error | undefined;
  const sandbox: SandboxSession = {
    async run(options: Parameters<SandboxSession["run"]>[0]) {
      commands.push(options);
      const result = spawnSync(process.execPath, ["-e", options.command], {
        env: options.env,
        encoding: "utf8",
      });
      return { exitCode: result.status!, stdout: result.stdout, stderr: result.stderr };
    },
    async spawn(options: Parameters<SandboxSession["spawn"]>[0]) {
      commands.push(options);
      return { pid: "process" } as never;
    },
  } as never;
  const handle: SandboxProviderHandle = {
    sandbox,
    async onSessionDelete() {
      if (deleteFailure) throw deleteFailure;
      lifecycle.push("delete");
    },
    async onSessionStop() {
      lifecycle.push("stop");
    },
    async onRuntimeShutdown() {
      lifecycle.push("shutdown");
    },
  };
  const inner: EveGhImplementation = {
    async prepare() {
      return {};
    },
    async start() {
      return { handle, state: started };
    },
    async resume(_context, _artifact, state) {
      resumedWith.push(state);
      return handle;
    },
  };
  const provider = withDevboxCredentials(
    inner,
    () => auth,
    async (url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer user-oauth");
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ path, method: init!.method!, body });
      if (failure?.path === path)
        return new Response("SECRET PROVIDER ERROR", { status: failure.status });
      if (path === "/v1/devbox/setup") {
        assert.equal(new URL(String(url)).searchParams.get("teamId"), auth.teamId);
        return Response.json({ id: "devbox_owner", registrationToken: "single-use-secret" });
      }
      if (path === "/v1/devbox/register") return Response.json(credentials);
      if (path === "/v1/devbox/devbox_owner" && init?.method === "DELETE") return Response.json({});
      assert.fail("Unexpected Devbox request");
    },
  );
  return {
    start: () => provider.start(context, undefined, {}),
    resume: (state: EveGhSessionState) => provider.resume(context, {}, state),
    requests,
    lifecycle,
    commands,
    resumedWith,
    setCredentials: (value: typeof credentials) => {
      credentials = value;
    },
    fail: (path: string, status: number) => {
      failure = { path, status };
    },
    failDelete: (error: Error) => {
      deleteFailure = error;
    },
  };
}

test("Devbox's owner tokens reach command processes; installation and unrelated secrets do not", async () => {
  const f = fixture();
  const { handle, state } = await f.start();
  assert.deepEqual(
    f.requests.map(({ body }) => body),
    [
      { sandboxId: "actual-sandbox-name", projectId: "prj_v", skipDevboxdInstall: true },
      { devboxId: "devbox_owner", registrationToken: "single-use-secret" },
    ],
  );
  const result = await handle.sandbox.run({
    command: `process.stdout.write(JSON.stringify({
      vercel: process.env.VERCEL_TOKEN === 'owner-vercel',
      github: process.env.GH_TOKEN === 'owner-github',
      aliases: process.env.VERCEL_API_KEY === process.env.VERCEL_TOKEN && process.env.GITHUB_TOKEN === process.env.GH_TOKEN,
      unrelated: process.env.UNRELATED_SECRET ?? null,
      supplied: process.env.SUPPLIED,
    }))`,
    env: { SUPPLIED: "kept", GH_TOKEN: "must-not-override-owner" },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    vercel: true,
    github: true,
    aliases: true,
    unrelated: null,
    supplied: "kept",
  });
  await handle.sandbox.spawn({ command: "server", env: { PORT: "3000" } });
  assert.equal(f.commands[1]!.env?.GITHUB_TOKEN, "owner-github");
  assert.equal(f.commands[1]!.env?.PORT, "3000");
  assert.deepEqual(state, {
    sandboxName: "actual-sandbox-name",
    version: 3,
    devboxId: "devbox_owner",
  });
  assert.equal(JSON.stringify(state).includes("owner-vercel"), false);
});

test("reconnect renews the same Devbox registration and uses fresh owner tokens", async () => {
  const f = fixture();
  const first = await f.start();
  await first.handle.onSessionStop();
  f.setCredentials({ vercelToken: "renewed-vercel", gitOauthToken: "renewed-github" });
  const second = await f.resume(first.state);
  assert.deepEqual(f.resumedWith, [{ sandboxName: "actual-sandbox-name", version: 3 }]);
  assert.equal(f.requests[2]!.body.devboxId, "devbox_owner");
  await second.sandbox.spawn({ command: "server" });
  assert.equal(f.commands[0]!.env?.VERCEL_TOKEN, "renewed-vercel");
  assert.equal(f.commands[0]!.env?.GH_TOKEN, "renewed-github");
  assert.deepEqual(f.lifecycle, ["stop"]);
});

test("missing human GitHub credentials fail before any command and revoke a new registration", async () => {
  const f = fixture();
  f.setCredentials({ vercelToken: "owner-vercel", gitToken: "installation-token" });
  await assert.rejects(f.start(), /Login Connections/);
  assert.equal(f.commands.length, 0);
  assert.equal(f.requests.at(-1)?.method, "DELETE");
  // No state is persisted for a failed start, so nothing could clean up later.
  assert.deepEqual(f.lifecycle, ["delete"]);
});

test("a failed reconnect stops but preserves the registration and workspace and hides provider error bodies", async () => {
  const f = fixture();
  f.fail("/v1/devbox/register", 403);
  await assert.rejects(f.resume({ ...started, devboxId: "devbox_owner" }), {
    message: "Devbox credential request failed (403).",
  });
  assert.equal(
    f.requests.some(({ method }) => method === "DELETE"),
    false,
  );
  assert.deepEqual(f.lifecycle, ["stop"]);
});

test("an invalid persisted Devbox identity is rejected before reconnecting", async () => {
  const f = fixture();
  await assert.rejects(
    f.resume({ ...started, devboxId: 42 } as never),
    /Invalid persisted Devbox identity/,
  );
  assert.deepEqual(f.resumedWith, []);
});

test("deletion revokes the Devbox record first, accepts already deleted, and permits retries", async () => {
  const f = fixture();
  const { handle } = await f.start();
  f.fail("/v1/devbox/devbox_owner", 403);
  await assert.rejects(handle.onSessionDelete(), /403/);
  assert.deepEqual(f.lifecycle, []);
  f.fail("/v1/devbox/devbox_owner", 404);
  await handle.onSessionDelete();
  assert.deepEqual(f.lifecycle, ["delete"]);
});

test("failed fresh setup deletes new compute without exposing the provider body", async () => {
  const f = fixture();
  f.fail("/v1/devbox/setup", 403);
  await assert.rejects(f.start(), {
    message: "Devbox credential request failed (403).",
  });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.lifecycle, ["delete"]);
});

test("failed fresh registration leaves neither compute nor registration", async () => {
  const f = fixture();
  f.fail("/v1/devbox/register", 403);
  await assert.rejects(f.start(), { message: "Devbox credential request failed (403)." });
  assert.deepEqual(
    f.requests.map(({ method, path }) => `${method} ${path}`),
    ["POST /v1/devbox/setup", "POST /v1/devbox/register", "DELETE /v1/devbox/devbox_owner"],
  );
  assert.deepEqual(f.lifecycle, ["delete"]);
});

test("cleanup failures stay visible alongside the original failure", async () => {
  const f = fixture();
  f.setCredentials({ vercelToken: "owner-vercel" });
  f.failDelete(new Error("compute delete failed"));
  await assert.rejects(f.start(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /Login Connections/);
    assert.deepEqual(
      error.errors.map((entry: Error) => entry.message),
      [
        "Connect GitHub in your Vercel account's Login Connections, then retry.",
        "compute delete failed",
      ],
    );
    return true;
  });
});
