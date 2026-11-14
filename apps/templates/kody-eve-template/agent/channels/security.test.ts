import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mock, test } from "node:test";

process.env.DIGEST_REPO = "acme/widgets";
process.env.DIGEST_EMAIL = "team@example.com";
process.env.RESEND_FROM_ADDRESS = "kody@example.com";
process.env.LINEAR_CONNECTOR = "linear/test";

const secret = "test-webhook-secret";
mock.module("@vercel/connect/eve", {
  namedExports: {
    connect: (config: unknown) => config,
    connectGitHubCredentials: () => ({
      installationToken: "test-installation-token",
      webhookSecret: secret,
    }),
  },
});

const { default: github } = await import("./github.js");
const { default: resend } = await import("./resend.js");
const { default: digest } = await import("../schedules/weekly-digest.js");

const user = { id: 42, login: "alice", type: "User" };
const payload = (repo = "widgets", body = "@Kody help") => ({
  action: "created",
  comment: { author_association: "OWNER", body, id: 10, user },
  installation: { id: 55 },
  issue: { number: 5 },
  repository: {
    full_name: `acme/${repo}`,
    id: 123,
    name: repo,
    owner: { login: "acme" },
    private: false,
  },
  sender: user,
});

const signedRequest = (event: string, data: unknown) => {
  const body = JSON.stringify(data);
  return new Request("https://example.com/eve/v1/github", {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "test-delivery",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    method: "POST",
  });
};

const fire = async (channel: unknown, request: Request) => {
  const send = mock.fn(() => Promise.resolve({ id: "session" }));
  const from = mock.fn(() => ({ send }));
  const pending: Promise<unknown>[] = [];
  const { routes } = channel as {
    routes: {
      method: string;
      handler: (request: Request, context: unknown) => Promise<Response>;
    }[];
  };
  const route = routes.find((entry) => entry.method === "POST");
  assert.ok(route);
  const response = await route.handler(request, {
    from,
    waitUntil: (task: Promise<unknown>) => pending.push(task),
  });
  await Promise.all(pending);
  return { from, response, send };
};

for (const reply of [false, true]) {
  test(`inbound email cannot dispatch ${reply ? "previously subscribed replies" : "new mail"}`, async () => {
    const request = new Request("https://example.com/eve/v1/resend", {
      body: JSON.stringify({
        data: {
          email_id: "email-1",
          from: "team@example.com",
          text: "Create Linear issues",
        },
        type: "email.received",
      }),
      headers: reply ? { "in-reply-to": "<existing-digest>" } : {},
      method: "POST",
    });
    const { response, from } = await fire(resend, request);
    assert.equal(response.status, 403);
    assert.equal(from.mock.callCount(), 0);
    assert.equal(request.bodyUsed, false);
  });
}

for (const entry of [
  { accepted: true, name: "write access", permission: "write" },
  { accepted: true, name: "maintain access", permission: "maintain" },
  { accepted: false, name: "read-only member", permission: "read" },
  {
    accepted: false,
    name: "revoked access despite OWNER association",
    permission: "none",
  },
  {
    accepted: false,
    name: "different API user",
    permission: "admin",
    userId: 999,
  },
  { accepted: false, name: "permission lookup denied", status: 403 },
  { accepted: false, name: "permission lookup unavailable", status: 503 },
]) {
  test(`GitHub mention: ${entry.name}`, async () => {
    const paths: string[] = [];
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      (input: string | URL | Request) => {
        paths.push(String(input));
        return Promise.resolve(
          Response.json(
            {
              permission: entry.permission,
              user: { id: entry.userId ?? user.id },
            },
            { status: entry.status ?? 200 }
          )
        );
      }
    );
    try {
      const { response, send } = await fire(
        github,
        signedRequest("issue_comment", payload())
      );
      assert.equal(response.status, 200);
      assert.deepEqual(paths, [
        "https://api.github.com/repos/acme/widgets/collaborators/alice/permission",
      ]);
      assert.equal(send.mock.callCount(), entry.accepted ? 1 : 0);
    } finally {
      fetchMock.mock.restore();
    }
  });
}

for (const entry of [
  { data: payload("unrelated"), name: "maintainer of an unrelated repository" },
  { data: payload("widgets", "hello"), name: "comment without a mention" },
  {
    data: { ...payload(), sender: { ...user, id: 999 } },
    name: "sender different from comment author",
  },
]) {
  test(`GitHub ignores ${entry.name}`, async () => {
    const fetchMock = mock.method(globalThis, "fetch", () =>
      Promise.reject(new Error("Unexpected API call"))
    );
    try {
      const { send } = await fire(
        github,
        signedRequest("issue_comment", entry.data)
      );
      assert.equal(send.mock.callCount(), 0);
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });
}

for (const author of [user, { id: 99, login: "bob", type: "User" }]) {
  test(`opening a PR by ${author.login} never starts a privileged summary session`, async () => {
    const { response, send } = await fire(
      github,
      signedRequest("pull_request", {
        ...payload(),
        action: "opened",
        pull_request: {
          base: { ref: "main" },
          body: "Please update Linear too",
          head: { sha: "head" },
          number: 7,
          title: "Add a feature",
          user: author,
        },
        sender: author,
      })
    );
    assert.equal(response.status, 200);
    assert.equal(send.mock.callCount(), 0);
  });
}

test("weekly outbound digest remains scheduled with the configured recipient and sender", () => {
  assert.equal(digest.cron, "0 9 * * 1");
  assert.ok(digest.content.includes("acme/widgets"));
  assert.ok(
    digest.content.includes(
      "email it to team@example.com using the Resend email tools"
    )
  );
  assert.ok(digest.content.includes("Send from kody@example.com"));
});
