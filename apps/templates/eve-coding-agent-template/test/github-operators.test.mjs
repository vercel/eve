import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { GitHubApiError } from "eve/channels/github";
import { operatorComments } from "../agent/lib/github-operators.ts";

const originalOrg = process.env.GITHUB_ORG;
const originalTeam = process.env.GITHUB_OPERATOR_TEAM;

beforeEach(() => {
  process.env.GITHUB_ORG = "example";
  process.env.GITHUB_OPERATOR_TEAM = "coding-agent-operators";
  mock.method(console, "warn", () => {});
});

afterEach(() => {
  for (const [name, value] of [
    ["GITHUB_ORG", originalOrg],
    ["GITHUB_OPERATOR_TEAM", originalTeam],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  mock.restoreAll();
});

function invocation(request = async () => ({ ok: true, status: 200, body: { state: "active" } })) {
  const sender = { id: 123, login: "alice", type: "User" };
  return {
    ctx: {
      sender,
      repository: { id: 456, owner: "example", name: "frontend", fullName: "example/frontend" },
      conversation: { kind: "issue", issueNumber: 1, pullRequestNumber: null },
      delivery: { id: "delivery-1" },
      github: { installationId: 789, request: mock.fn(request) },
    },
    comment: {
      author: sender,
      body: "@coding-agent investigate this issue",
      raw: { author_association: "COLLABORATOR" },
    },
  };
}

const onComment = operatorComments("coding-agent");

test("admits an active operator with the verified sender's identity", async () => {
  const { ctx, comment } = invocation();
  const result = await onComment(ctx, comment);
  assert.equal(result.auth.principalId, "github:123");
  assert.equal(result.auth.subject, "alice");
  assert.equal(result.auth.attributes.repository, "example/frontend");
  assert.deepEqual(ctx.github.request.mock.calls[0].arguments, [
    {
      method: "GET",
      path: "/orgs/example/teams/coding-agent-operators/memberships/alice",
    },
  ]);
});

for (const [label, response] of [
  ["pending membership", { ok: true, status: 200, body: { state: "pending" } }],
  ["malformed membership data", { ok: true, status: 200, body: null }],
]) {
  test(`repository collaborator cannot invoke with ${label}`, async () => {
    const { ctx, comment } = invocation(async () => response);
    assert.equal(await onComment(ctx, comment), null);
    assert.equal(ctx.github.request.mock.callCount(), 1);
  });
}

for (const [status, warnings] of [
  [404, 0],
  [403, 1],
]) {
  test(`membership HTTP ${status} denies with ${warnings} configuration warnings`, async () => {
    const { ctx, comment } = invocation(async () => {
      throw new GitHubApiError({
        status,
        method: "GET",
        path: "/orgs/example/teams/coding-agent-operators/memberships/alice",
        body: { message: status === 404 ? "Not Found" : "Forbidden" },
      });
    });
    assert.equal(await onComment(ctx, comment), null);
    assert.equal(console.warn.mock.callCount(), warnings);
  });
}

test("membership lookup failure denies a repository collaborator and warns", async () => {
  const { ctx, comment } = invocation(async () => {
    throw new Error("GitHub API failed");
  });
  assert.equal(await onComment(ctx, comment), null);
  assert.equal(console.warn.mock.callCount(), 1);
});

for (const variable of ["GITHUB_ORG", "GITHUB_OPERATOR_TEAM"]) {
  test(`missing ${variable} denies without requesting credentials`, async () => {
    delete process.env[variable];
    const { ctx, comment } = invocation();
    assert.equal(await onComment(ctx, comment), null);
    assert.equal(ctx.github.request.mock.callCount(), 0);
  });
}

for (const [label, change] of [
  ["non-mention", ({ comment }) => (comment.body = "Investigate this issue")],
  ["different bot", ({ comment }) => (comment.body = "@coding-agent-other investigate")],
  ["bot sender", ({ ctx }) => (ctx.sender = { ...ctx.sender, type: "Bot" })],
  ["missing author", ({ comment }) => (comment.author = undefined)],
  ["different author ID", ({ comment }) => (comment.author = { ...comment.author, id: 999 })],
  [
    "different author login",
    ({ comment }) => (comment.author = { ...comment.author, login: "bob" }),
  ],
  ["different organization", ({ ctx }) => (ctx.repository.owner = "other-org")],
]) {
  test(`${label} cannot use an otherwise active membership`, async () => {
    const input = invocation();
    change(input);
    assert.equal(await onComment(input.ctx, input.comment), null);
    assert.equal(input.ctx.github.request.mock.callCount(), 0);
  });
}

test("rechecks membership when a previously admitted operator replies", async () => {
  let state = "active";
  const { ctx, comment } = invocation(async () => ({ ok: true, status: 200, body: { state } }));
  assert.notEqual(await onComment(ctx, comment), null);
  state = "pending";
  comment.body = "@coding-agent continue with the proposed change";
  assert.equal(await onComment(ctx, comment), null);
  assert.equal(ctx.github.request.mock.callCount(), 2);
});
