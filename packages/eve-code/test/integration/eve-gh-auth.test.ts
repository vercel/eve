import assert from "node:assert/strict";
import test from "node:test";
import type { ToolAuthProvider, ToolContext } from "eve/tools";

import { currentEveGhAuth, getEveGhSandbox } from "../../extension/lib/eve-gh-auth.ts";
import { eveGhImplementation } from "../../extension/lib/eve-gh-sandbox.ts";

const vercelAuth: ToolAuthProvider = {
  principalType: "user",
  async getToken() {
    return { token: "unused" };
  },
} as never;

const settings = {
  auth: vercelAuth,
  repository: "https://github.com/vercel/internal-agents",
  teamId: "team_test",
  projectId: "prj_test",
};

function fixture(id = "alice") {
  let saved: { caller: string; vercelUserId: string } | null = null;
  const state = {
    get: () => saved,
    update: (fn: (value: typeof saved) => typeof saved) => {
      saved = fn(saved);
    },
  };
  const calls: string[] = [];
  const ctx: ToolContext = {
    session: {
      id: `session-${id}`,
      auth: { current: { principalId: id, principalType: "user", issuer: "slack:T" } },
    },
    abortSignal: new AbortController().signal,
    async getToken(provider: unknown) {
      assert.equal(provider, vercelAuth);
      calls.push("authorize");
      return { token: `token-${id}` };
    },
    requireAuth() {
      throw new Error("consent required");
    },
    async getSandbox() {
      calls.push("sandbox");
      const auth = currentEveGhAuth(`session-${id}`);
      assert.equal(auth.token, `token-${id}`);
      assert.deepEqual(auth.commitAs, { name: id, email: `${id}@example.com` });
      assert.equal(auth.projectId, settings.projectId);
      await Promise.resolve();
      assert.equal(currentEveGhAuth(`session-${id}`).token, `token-${id}`);
      return { id: `sbx-${id}` };
    },
  } as never;
  const send = (async (input, init) => {
    assert.equal(input, "https://api.vercel.com/login/oauth/userinfo");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer token-${id}`);
    calls.push("identity");
    return Response.json({
      sub: `vercel-${id}`,
      name: id,
      preferred_username: id,
      email: `${id}@example.com`,
    });
  }) satisfies typeof fetch;
  return { ctx, state, send, calls };
}

test("user authorization and verified identity precede sandbox creation; only ownership is saved", async () => {
  const f = fixture();
  await getEveGhSandbox(f.ctx, settings, f.state, f.send);
  assert.deepEqual(f.calls, ["authorize", "identity", "sandbox"]);
  assert.deepEqual(f.state.get(), { caller: '["slack:T","alice"]', vercelUserId: "vercel-alice" });
  assert.throws(() => currentEveGhAuth("session-alice"), /Authorize Vercel/);
  f.calls.length = 0;
  await getEveGhSandbox(f.ctx, settings, f.state, f.send);
  assert.deepEqual(f.calls, ["authorize", "identity", "sandbox"]);
});

test("consent challenges and anonymous callers cannot create a sandbox", async () => {
  const f = fixture();
  const challenge = new Error("consent required");
  f.ctx.getToken = async () => {
    throw challenge;
  };
  await assert.rejects(
    getEveGhSandbox(f.ctx, settings, f.state, f.send),
    (error) => error === challenge,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.get(), null);
  const anonymous = {
    ...f.ctx,
    session: { ...f.ctx.session, auth: { current: null, initiator: null } },
  };
  await assert.rejects(getEveGhSandbox(anonymous, settings, f.state, f.send), /authenticated user/);
});

test("expired tokens require consent again before sandbox access", async () => {
  const f = fixture();
  await assert.rejects(
    getEveGhSandbox(f.ctx, settings, f.state, async () => new Response(null, { status: 401 })),
    /consent required/,
  );
  assert.deepEqual(f.calls, ["authorize"]);
  assert.equal(f.state.get(), null);
});

test("another caller or another Vercel account cannot reuse the sandbox", async () => {
  const alice = fixture();
  await getEveGhSandbox(alice.ctx, settings, alice.state, alice.send);
  const bob = fixture("bob");
  await assert.rejects(getEveGhSandbox(bob.ctx, settings, alice.state, bob.send), /another user/);
  assert.deepEqual(bob.calls, []);
  alice.calls.length = 0;
  await assert.rejects(
    getEveGhSandbox(alice.ctx, settings, alice.state, async () =>
      Response.json({ sub: "vercel-bob", preferred_username: "bob", email: "bob@example.com" }),
    ),
    /another Vercel account/,
  );
  assert.deepEqual(alice.calls, ["authorize"]);
});

test("concurrent users have isolated creation credentials", async () => {
  const alice = fixture();
  const bob = fixture("bob");
  await Promise.all([
    getEveGhSandbox(alice.ctx, settings, alice.state, alice.send),
    getEveGhSandbox(bob.ctx, settings, bob.state, bob.send),
  ]);
  assert.notDeepEqual(alice.state.get(), bob.state.get());
  assert.throws(() => currentEveGhAuth("session-alice"), /Authorize Vercel/);
  assert.throws(() => currentEveGhAuth("session-bob"), /Authorize Vercel/);
});

test("identity lookup errors never reach the sandbox or expose the response body", async () => {
  const f = fixture();
  await assert.rejects(
    getEveGhSandbox(
      f.ctx,
      settings,
      f.state,
      async () => new Response("private provider error", { status: 403 }),
    ),
    { message: "Vercel account lookup failed (403)." },
  );
  assert.deepEqual(f.calls, ["authorize"]);
});

test("the caller's OAuth token and verified identity reach the real Sandbox SDK request", async () => {
  const f = fixture();
  let creates = 0;
  const provider = eveGhImplementation((context) => ({
    ...currentEveGhAuth(context.session.id),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get("authorization"), "Bearer token-alice");
      if (request.method === "GET") {
        return Response.json({ error: { message: "Not found" } }, { status: 404 });
      }
      creates++;
      const body = await request.json();
      assert.equal(body.projectId, settings.projectId);
      assert.deepEqual(body.source, { type: "git", url: settings.repository, credentials: true });
      assert.deepEqual(body.commitAs, { name: "alice", email: "alice@example.com" });
      return Response.json({ error: { message: "Preview disabled" } }, { status: 400 });
    },
  }));
  f.ctx.getSandbox = async () => {
    const { handle } = await provider.start(
      {
        host: {} as never,
        session: {
          auth: { current: null, initiator: null },
          id: "session-alice",
          turn: { id: "turn", sequence: 0 },
        },
        storagePath: "/unused",
      },
      undefined,
      {},
    );
    return handle.sandbox as never;
  };
  await assert.rejects(getEveGhSandbox(f.ctx, settings, f.state, f.send), /Preview disabled/);
  assert.equal(creates, 1);
  assert.throws(() => currentEveGhAuth("session-alice"), /Authorize Vercel/);
});

test("overlapping opens in one session each see their own credentials and settings", async () => {
  const shared = fixture("shared");
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  function opener(label: string, opts: { gate?: Promise<void>; fail?: boolean } = {}) {
    const ctx = {
      ...shared.ctx,
      async getToken() {
        return { token: `token-${label}` };
      },
      async getSandbox() {
        order.push(`${label}:enter`);
        const before = currentEveGhAuth("session-shared");
        assert.equal(before.token, `token-${label}`);
        assert.equal(before.projectId, `prj_${label}`);
        if (label === "first") firstEntered();
        await opts.gate;
        await new Promise((resolve) => setImmediate(resolve));
        const after = currentEveGhAuth("session-shared");
        assert.equal(after.token, `token-${label}`);
        assert.equal(after.projectId, `prj_${label}`);
        assert.equal(after.repository, `https://github.com/vercel/${label}`);
        order.push(`${label}:exit`);
        if (opts.fail) throw new Error(`${label} failed`);
        return { id: `sbx-${label}` };
      },
    } as never;
    const send = (async () =>
      Response.json({
        sub: "vercel-shared",
        preferred_username: "shared",
        email: "shared@example.com",
      })) satisfies typeof fetch;
    return getEveGhSandbox(
      ctx,
      { ...settings, projectId: `prj_${label}`, repository: `https://github.com/vercel/${label}` },
      shared.state,
      send,
    );
  }

  // first opens and blocks; second (and a failing third) start while first is active.
  const first = opener("first", { gate: firstGate, fail: true });
  await firstStarted;
  const second = opener("second");
  const third = opener("third", { fail: true });
  // Let second and third reach the lock before first finishes.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:enter"]);
  releaseFirst();
  const results = await Promise.allSettled([first, second, third]);
  assert.equal(results[0].status, "rejected");
  assert.deepEqual(results[1], { status: "fulfilled", value: { id: "sbx-second" } });
  assert.equal(results[2].status, "rejected");
  assert.deepEqual(order, [
    "first:enter",
    "first:exit",
    "second:enter",
    "second:exit",
    "third:enter",
    "third:exit",
  ]);
  assert.throws(() => currentEveGhAuth("session-shared"), /Authorize Vercel/);
});
