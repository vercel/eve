import assert from "node:assert/strict";
import test from "node:test";

import { eveGhImplementation } from "../../extension/lib/eve-gh-sandbox.ts";

const context = {
  host: {} as never,
  session: {
    auth: { current: null, initiator: null },
    id: "managed-session",
    turn: { id: "turn", sequence: 0 },
  },
  storagePath: "/unused",
};

const emptyResources = { source: { kind: "none" as const } };
const prepareContext = (resources: object) =>
  ({ resources, files: {}, host: {}, sourceRevision: "rev", storagePath: "/unused" }) as never;

const credentials = {
  enabled: true,
  repository: "https://github.com/vercel/internal-agents",
  token: "test-user-token",
  teamId: "team_test",
  projectId: "prj_test",
  revision: "test-revision",
  commitAs: { name: "Test User", email: "test@example.com" },
};

const unreachable = () => assert.fail("resolved credentials");

test("preparation never resolves credentials and refuses template seeds", async () => {
  const provider = eveGhImplementation(unreachable);
  assert.deepEqual(await provider.prepare(prepareContext(emptyResources)), {});
  const seeded = {
    ...emptyResources,
    workspace: {
      files: [{ content: "x", relativePath: "x" }],
      key: "k",
      mountPath: "/m",
      targetPath: "/workspace",
    },
  };
  await assert.rejects(
    provider.prepare(prepareContext(seeded)),
    /cannot inherit template credentials/,
  );
});

test("disabled launches fail before accessing the API", async () => {
  const provider = eveGhImplementation(() => ({ ...credentials, enabled: false }));
  await assert.rejects(provider.start(context, undefined, {}), /disabled/);
  await assert.rejects(
    provider.resume(context, {}, { sandboxName: "sbx", version: 3 }),
    /disabled/,
  );
});

test("rejects invalid repository URLs and missing credentials before accessing the API", async () => {
  for (const invalid of [
    { repository: "http://github.com/vercel/internal-agents" },
    { repository: "https://gitlab.com/vercel/internal-agents" },
    { repository: "https://secret@github.com/vercel/internal-agents" },
    { repository: "https://github.com/vercel/internal-agents?token=secret" },
    { repository: "https://github.com/vercel/internal-agents/tree/main" },
    { token: "" },
    { teamId: "" },
    { projectId: "" },
    { commitAs: { name: "", email: "test@example.com" } },
    { commitAs: { name: "Test User", email: "" } },
  ]) {
    await assert.rejects(
      eveGhImplementation(() => ({
        ...credentials,
        ...invalid,
        fetch: async () => assert.fail("invalid options reached the network"),
      })).start(context, undefined, {}),
      /eve-gh requires/,
    );
  }
});

test("the real Eve SDK sends the preview fields and propagates a managed Git rejection", async () => {
  const requests: Request[] = [];
  await assert.rejects(
    eveGhImplementation(() => ({
      ...credentials,
      timeout: 120_000,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") {
          return Response.json({ error: { message: "Not found" } }, { status: 404 });
        }
        return Response.json(
          { error: { message: "Managed Git credentials are not enabled for this project." } },
          { status: 400 },
        );
      },
    })).start(context, undefined, {}),
    /Managed Git credentials are not enabled/,
  );
  assert.equal(requests.length, 2);
  const request = requests[1]!;
  assert.match(new URL(request.url).pathname, /^\/(?:api\/)?v[23]\/sandboxes$/);
  assert.equal(request.headers.get("authorization"), "Bearer test-user-token");
  const body = await request.json();
  assert.deepEqual(body.source, {
    type: "git",
    url: credentials.repository,
    revision: credentials.revision,
    credentials: true,
  });
  assert.deepEqual(body.commitAs, credentials.commitAs);
  assert.equal(body.projectId, credentials.projectId);
  assert.equal(body.timeout, 120_000);
});

test("creates from Git and resumes the same sandbox without recreating its grant", async () => {
  const requests: { method: string; path: string; body?: Record<string, unknown> }[] = [];
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
  const sandbox = () => ({
    name,
    persistent: true,
    createdAt: 1,
    updatedAt: 1,
    currentSessionId: session.id,
    status: "running",
    statusUpdatedAt: 1,
  });
  const response = () => Response.json({ sandbox: sandbox(), session, routes: [] });
  let exists = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^\/api/, "");
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: request.method, path, body });
    const named = /^\/v2\/sandboxes\/([^/]+)$/.exec(path);
    if (request.method === "GET" && named) {
      return exists && named[1] === name
        ? response()
        : Response.json({ error: { message: "Not found" } }, { status: 404 });
    }
    if (request.method === "POST" && /^\/v[23]\/sandboxes$/.test(path)) {
      exists = true;
      name = body.name;
      return response();
    }
    if (path.endsWith("/cmd")) {
      const command = {
        id: "cmd_test",
        sessionId: session.id,
        name: body.command,
        args: body.args,
        cwd: "/workspace",
        startedAt: 1,
        exitCode: 0,
      };
      return new Response(`${JSON.stringify({ command })}\n${JSON.stringify({ command })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    if (request.method === "POST" && path.endsWith("/stop")) {
      return Response.json({ session: { ...session, status: "stopped" } });
    }
    if (request.method === "DELETE" && named) {
      exists = false;
      return Response.json({ sandbox: sandbox() });
    }
    assert.fail(`Unexpected sandbox request: ${request.method} ${path}`);
  };
  const provider = eveGhImplementation(() => ({ ...credentials, fetch }));
  const started = await provider.start(context, undefined, {});
  assert.equal(started.handle.sandbox.resolvePath("test.ts"), "/workspace/test.ts");
  assert.equal(started.state.sandboxName, name);
  const resumed = await provider.resume(context, {}, started.state);
  assert.equal(resumed.sandbox.resolvePath("test.ts"), "/workspace/test.ts");
  const creates = requests.filter(
    (r) => r.method === "POST" && /^\/v[23]\/sandboxes$/.test(r.path),
  );
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0]!.body?.source, {
    type: "git",
    url: credentials.repository,
    revision: credentials.revision,
    credentials: true,
  });
  assert.deepEqual(creates[0]!.body?.commitAs, credentials.commitAs);
  assert.equal(creates[0]!.body?.persistent, true);
  // Provider loss fails resume rather than silently recreating a checkout.
  exists = false;
  await assert.rejects(provider.resume(context, {}, started.state), /no longer exists/);
  exists = true;
  await resumed.onSessionDelete();
  assert.equal(exists, false);
  for (const request of requests.filter((r) => !/^\/v[23]\/sandboxes$/.test(r.path))) {
    assert.equal(request.body?.commitAs, undefined);
    assert.equal(request.body?.source, undefined);
  }
});
