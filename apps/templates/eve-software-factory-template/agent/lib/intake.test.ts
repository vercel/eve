import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";

process.env.FACTORY_REPO = "acme/widgets";
process.env.LINEAR_CONNECTOR = "linear/test";
const secret = "a".repeat(32);
process.env.FACTORY_INTAKE_TOKEN = secret;
mock.module("eve/channels", {
  namedExports: {
    defineChannel: (config: unknown) => config,
    GET: (path: string, handler: unknown) => ({ handler, path }),
    POST: (path: string, handler: unknown) => ({ handler, path }),
  },
});
const claims = new Set<string>();
let storageFailure = false;
mock.module("@vercel/blob", {
  namedExports: {
    BlobNotFoundError: class extends Error {},
    del: () => assert.fail("ticket claims must not be released"),
    get: () => assert.fail("claiming must not use read-then-write"),
    head: () => assert.fail("claiming must not use read-then-write"),
    put: async (key: string, _text: string, options: any) => {
      await Promise.resolve();
      assert.equal(options.access, "private");
      assert.equal(options.allowOverwrite, false);
      if (storageFailure || claims.has(key)) {
        throw new Error("Claim rejected");
      }
      claims.add(key);
    },
  },
});
const { default: channel } = (await import("../channels/intake.js")) as any;
const policies = await import("./github/approval.js");
const { stampAutonomous } = await import("./trust.js");
const post = channel.routes[0].handler;
const get = channel.routes[1].handler;
const sent: any[] = [];
const sessions = new Map<string, any>();
let failDispatch = false;
const ctx = {
  from: (address: string) => ({
    send: (message: unknown, options: unknown) => {
      sent.push({ address, message, options });
      if (failDispatch) {
        return Promise.reject(new Error("Private internal storage error"));
      }
      sessions.set(address, {
        *stream() {
          /* A queued session has no events yet. */
        },
      });
      return Promise.resolve({ sessionId: "session-1" });
    },
  }),
  resolveSession: (address: string) => Promise.resolve(sessions.get(address)),
};
const request = (body: unknown, token: string | null = secret) =>
  new Request("https://factory.example/intake/v1/tickets", {
    body: JSON.stringify(body),
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    method: "POST",
  });
const ticket = {
  body: "Alice reports duplicate emails; Bob will investigate.",
  externalId: "ticket-1",
  title: "Email delivery",
};

test("HTTP intake authenticates before work, rejects oversized/unknown input, and never inherits trusted or thread writes", async () => {
  await Promise.all(
    [null, "wrong", "oidc-looking-token"].map(async (token) => {
      assert.equal((await post(request(ticket, token), ctx)).status, 401);
    })
  );
  await Promise.all(
    [
      { trusted: true },
      { ticketBranch: "factory/ready" },
      { auth: { ticketBranch: "factory/ready" } },
    ].map(async (stamp) => {
      assert.equal(
        (await post(request({ ...ticket, ...stamp }), ctx)).status,
        400
      );
    })
  );
  assert.equal(
    (
      await post(
        request({ ...ticket, callbackUrl: "https://example.com" }),
        ctx
      )
    ).status,
    400
  );
  assert.equal(
    (await post(request({ ...ticket, body: "x".repeat(70_000) }), ctx)).status,
    413
  );
  const streamed = new Request("https://factory.example/intake/v1/tickets", {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(70_000));
        controller.close();
      },
    }),
    duplex: "half",
    headers: { authorization: `Bearer ${secret}` },
    method: "POST",
  } as RequestInit);
  assert.equal((await post(streamed, ctx)).status, 413);
  assert.equal(sent.length, 0);
  assert.equal(claims.size, 0);

  const results = await Promise.all([
    post(request(ticket), ctx),
    post(request(ticket), ctx),
  ]);
  assert.deepEqual(
    results.map((response) => response.status).sort(),
    [202, 409]
  );
  assert.equal(sent.length, 1);
  const { auth } = sent[0].options;
  assert.equal(auth.principalType, "service");
  assert.equal(auth.attributes.factoryRepository, "acme/widgets");
  const expectedBranch = `factory/ticket-${createHash("sha256").update(sent[0].address).digest("hex")}`;
  assert.equal(auth.attributes.ticketBranch, expectedBranch);
  assert.ok(
    sent[0].options.context.some((text: string) =>
      text.includes(expectedBranch)
    )
  );
  const approvalCtx = {
    session: { auth: { current: auth } },
    toolInput: { issueNumber: 7, state: "closed" },
  } as any;
  for (const policy of [
    policies.writePolicy,
    policies.commentPolicy,
    policies.factoryBrainPolicy,
    policies.shipPolicy,
    policies.labelPolicy,
    policies.closeIssuePolicy,
    policies.updateIssuePolicy,
  ]) {
    assert.equal((policy(approvalCtx) as any).type, "denied");
  }
  const issueCtx = {
    ...approvalCtx,
    session: {
      auth: {
        current: stampAutonomous(
          { ...auth, authenticator: "github-webhook" },
          7
        ),
      },
    },
  };
  for (const policy of [
    policies.labelPolicy,
    policies.closeIssuePolicy,
    policies.updateIssuePolicy,
  ]) {
    assert.equal(policy(issueCtx), "not-applicable");
  }
  assert.equal(
    policies.createPullRequestPolicy({
      ...approvalCtx,
      toolInput: { draft: true },
    }),
    "not-applicable"
  );
  assert.equal((await post(request(ticket), ctx)).status, 200);
  assert.equal(sent.length, 1);
});

test("ticket status stays in the authenticated address space; permanent claims survive session loss and dispatch failure", async () => {
  const { ticketId } = await (await post(request(ticket), ctx)).json();
  const read = () =>
    new Request(`https://factory.example/intake/v1/tickets/${ticketId}`, {
      headers: { authorization: `Bearer ${process.env.FACTORY_INTAKE_TOKEN}` },
    });
  assert.equal(
    (await get(read(), { ...ctx, params: { ticketId } })).status,
    200
  );
  const { address } = sent[0];
  sessions.set(address, {
    *stream() {
      yield { payload: "x".repeat(4 * 1024 * 1024) };
    },
  });
  assert.equal(
    (await get(read(), { ...ctx, params: { ticketId } })).status,
    413
  );
  process.env.FACTORY_INTAKE_TOKEN = "b".repeat(32);
  assert.equal(
    (await get(read(), { ...ctx, params: { ticketId } })).status,
    404
  );
  process.env.FACTORY_INTAKE_TOKEN = secret;
  sessions.clear();
  assert.equal((await post(request(ticket), ctx)).status, 409);
  assert.equal(sent.length, 1);
  failDispatch = true;
  const failed = { ...ticket, externalId: "ticket-2" };
  const response = await post(request(failed), ctx);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("Private internal"));
  failDispatch = false;
  assert.equal((await post(request(failed), ctx)).status, 409);
  storageFailure = true;
  assert.equal(
    (await post(request({ ...ticket, externalId: "ticket-3" }), ctx)).status,
    409
  );
  assert.equal(sent.length, 2);
});
