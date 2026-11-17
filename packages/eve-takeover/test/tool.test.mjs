import assert from "node:assert/strict";
import test from "node:test";

import { isConnectionAuthorizationRequiredError } from "eve/connections";
import {
  defineTakeover,
  openTakeoverGrant,
  runTakeoverTool,
  TAKEOVER_DONE_PARAM,
  viewerPage,
  viewerToken,
  verifyStreamToken,
} from "@eve/takeover/core";

const BASE = "https://agent.example";
const CALLBACK = `${BASE}/eve/v1/connections/callback/attempt_1`;
const REQUESTER = {
  authenticator: "slack",
  principalType: "user",
  principalId: "U1",
  attributes: {},
};

function fakeSandbox() {
  const commands = [];
  const files = [];
  return {
    name: "sbx",
    commands,
    files,
    async run({ command, env }) {
      commands.push({ command, env });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeTextFile(file) {
      files.push(file);
    },
  };
}

function fakeExposer() {
  const calls = [];
  return {
    calls,
    async open(_sandbox, port) {
      calls.push(`open:${port}`);
      return { url: "https://sb-4791.vercel.run" };
    },
    async close(_sandbox, port) {
      calls.push(`close:${port}`);
    },
  };
}

const viewerAuth = async (request) => {
  const user = request.headers.get("x-test-user");
  return user
    ? { authenticator: "slack", principalType: "user", principalId: user, attributes: {} }
    : null;
};

function setup(overrides = {}) {
  const expose = fakeExposer();
  const takeover = defineTakeover({
    secret: "s".repeat(32),
    auth: viewerAuth,
    baseUrl: BASE,
    expose,
    ...overrides,
  });
  return { takeover, expose };
}

function source(options = {}) {
  const released = [];
  return {
    released,
    label: "browser",
    protocol: "screencast",
    upstream: "websocket",
    async prepare() {
      return options.unavailable
        ? { unavailable: options.unavailable }
        : { portCommand: "echo 9222" };
    },
    async release() {
      released.push(true);
    },
  };
}

/**
 * Stands in for eve's sign-in: probes the provider, starts the authorization
 * with a callback URL, then completes it with what the viewer's button sends.
 */
function fakeCtx(sandbox, { callback, onChallenge }) {
  return {
    callId: "call_1",
    session: { id: "ses_1", auth: { current: REQUESTER } },
    getSandbox: async () => sandbox,
    async getToken(provider, options) {
      assert.match(options.authKey, /^takeover:/);
      await assert.rejects(provider.getToken({ principal: {}, connection: { url: "" } }), (error) =>
        isConnectionAuthorizationRequiredError(error),
      );
      const { challenge } = await provider.startAuthorization({
        principal: {},
        connection: { url: "" },
        callbackUrl: CALLBACK,
      });
      onChallenge?.(challenge);
      return await provider.completeAuthorization({
        principal: {},
        connection: { url: "" },
        callbackUrl: CALLBACK,
        callback: { method: "GET", params: callback },
      });
    },
  };
}

test("a takeover the person finishes opens the stream, links the viewer, and cleans up", async () => {
  const { takeover, expose } = setup();
  const sandbox = fakeSandbox();
  const src = source();
  let challenge;
  const result = await runTakeoverTool(
    takeover,
    fakeCtx(sandbox, {
      callback: { [TAKEOVER_DONE_PARAM]: "done" },
      onChallenge: (c) => (challenge = c),
    }),
    src,
    "Sign in to Linear",
  );
  assert.deepEqual(result, { status: "done" });
  assert.deepEqual(expose.calls, ["open:4791", "close:4791"]);
  assert.equal(src.released.length, 1);
  assert.equal(sandbox.files[0].path, "/tmp/eve-takeover/proxy.mjs");
  const launch = sandbox.commands.find(({ command }) => command.includes("nohup node"));
  assert.equal(launch.env.EVE_TAKEOVER_PORT_COMMAND, "echo 9222");
  assert.equal(launch.env.EVE_TAKEOVER_ALLOWED_ORIGIN, BASE);
  assert.ok(challenge.url.startsWith(`${BASE}/takeover/`));
  assert.ok(challenge.expiresAt);

  const opened = openTakeoverGrant(takeover.keys, challenge.url.split("/takeover/")[1]);
  assert.equal(opened.status, "ok");
  assert.equal(opened.grant.stream, "wss://sb-4791.vercel.run/stream");
  assert.equal(opened.grant.callback, CALLBACK);
  assert.deepEqual(opened.grant.requester, REQUESTER);
});

test("Cancel, an expired sign-in, or a new message hands control back as cancelled", async () => {
  const { takeover, expose } = setup();
  const result = await runTakeoverTool(
    takeover,
    fakeCtx(fakeSandbox(), { callback: { error: "access_denied" } }),
    source(),
    "Sign in",
  );
  assert.equal(result.status, "cancelled");
  assert.deepEqual(expose.calls, ["open:4791", "close:4791"]);
});

test("a source with nothing to share is unavailable before anyone is asked", async () => {
  const { takeover, expose } = setup();
  const result = await runTakeoverTool(
    takeover,
    fakeCtx(fakeSandbox(), { callback: {} }),
    source({ unavailable: "No browser page is open." }),
    "Sign in",
  );
  assert.deepEqual(result, { status: "unavailable", reason: "No browser page is open." });
  assert.deepEqual(expose.calls, []);
});

test("only a person's own turn can take over", async () => {
  const { takeover } = setup();
  const ctx = fakeCtx(fakeSandbox(), { callback: {} });
  const result = await runTakeoverTool(
    takeover,
    { ...ctx, session: { id: "ses_1", auth: { current: null } } },
    source(),
    "Sign in",
  );
  assert.equal(result.status, "unavailable");
});

async function linkFor(takeover) {
  let challenge;
  await runTakeoverTool(
    takeover,
    fakeCtx(fakeSandbox(), {
      callback: { [TAKEOVER_DONE_PARAM]: "done" },
      onChallenge: (c) => (challenge = c),
    }),
    source(),
    "Sign in to Linear",
  );
  return challenge.url.split("/takeover/")[1];
}

test("the viewer page admits only the requester and locks itself down", async () => {
  const { takeover } = setup({ signInUrl: (returnTo) => `${BASE}/signin?next=${returnTo}` });
  const sealed = await linkFor(takeover);
  const page = (user) =>
    viewerPage(
      takeover,
      new Request(`${BASE}/takeover/${sealed}`, { headers: user ? { "x-test-user": user } : {} }),
      sealed,
    );

  const anonymous = await page(null);
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get("location"), `${BASE}/signin?next=/takeover/${sealed}`);
  assert.equal((await page("U2")).status, 403);
  assert.equal((await viewerPage(takeover, new Request(`${BASE}/takeover/x`), "x")).status, 400);

  const ok = await page("U1");
  assert.equal(ok.status, 200);
  const csp = ok.headers.get("content-security-policy");
  assert.match(csp, /connect-src 'self' wss:\/\/sb-4791\.vercel\.run/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const html = await ok.text();
  assert.match(html, /Sign in to Linear/);
  assert.ok(html.includes(`${CALLBACK}?${TAKEOVER_DONE_PARAM}=done`));
  assert.ok(html.includes(`${CALLBACK}?error=access_denied`));
});

test("stream tokens go only to the requester, from the agent's own origin", async () => {
  const { takeover } = setup();
  const sealed = await linkFor(takeover);
  const tokenRequest = (headers) =>
    viewerToken(
      takeover,
      new Request(`${BASE}/takeover/${sealed}/token`, { method: "POST", headers }),
      sealed,
    );
  assert.equal((await tokenRequest({ "x-test-user": "U1" })).status, 403);
  assert.equal(
    (await tokenRequest({ "x-test-user": "U1", origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await tokenRequest({ "x-test-user": "U2", origin: BASE })).status, 403);
  const ok = await tokenRequest({ "x-test-user": "U1", origin: BASE });
  assert.equal(ok.status, 200);
  const { token } = await ok.json();
  assert.ok(
    verifyStreamToken(takeover.keys.publicKeySpki, token, { sessionId: "ses_1", callId: "call_1" }),
  );
});

test("isRequester maps viewers who sign in differently than they chat", async () => {
  const { takeover } = setup({
    isRequester: (viewer, requester) => viewer.principalId === `okta:${requester.principalId}`,
  });
  const sealed = await linkFor(takeover);
  const page = (user) =>
    viewerPage(
      takeover,
      new Request(`${BASE}/takeover/${sealed}`, { headers: { "x-test-user": user } }),
      sealed,
    );
  assert.equal((await page("U1")).status, 403);
  assert.equal((await page("okta:U1")).status, 200);
});
