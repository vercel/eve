import assert from "node:assert/strict";
import test from "node:test";

(globalThis as Record<symbol, unknown>)[Symbol.for("eve.ext-config-scope")] =
  "eve-code-prwatch-authorize-test";
const { default: extension } = await import("../../extension/extension.ts");
const { readPullRequestWatchSnapshot } = await import("../../extension/lib/prwatch-github.ts");

const HEAD = "b".repeat(40);

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

test("asks authorize before a pull request watch reads GitHub", async (t) => {
  process.env.VERCEL_OIDC_TOKEN = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const githubRequests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.vercel.com/v1/connect/token/")) {
      return Response.json({ token: "watch-token", expiresAt: Date.now() + 3_600_000 });
    }
    githubRequests.push(url);
    return Response.json(
      url.endsWith("/reviews?per_page=100&page=1")
        ? []
        : {
            head: { sha: HEAD },
            html_url: "https://github.com/acme/widgets/pull/1",
            state: "open",
          },
    );
  });
  const requests: unknown[] = [];
  extension({
    github: {
      connector: "github/acme-bot",
      broker: async () => {},
      authorize: (request) => {
        requests.push(request);
        return request.repository.startsWith("vercel/");
      },
    },
  });
  const input = { pullRequestNumber: 1, reviewOwner: "octocat", redHeadOid: HEAD };

  await assert.rejects(
    readPullRequestWatchSnapshot({ ...input, repo: "acme/widgets" }),
    /not authorized to access acme\/widgets/u,
  );
  assert.deepEqual(requests, [{ auth: null, repository: "acme/widgets", token: "watch-token" }]);
  assert.deepEqual(githubRequests, []);

  const snapshot = await readPullRequestWatchSnapshot({ ...input, repo: "vercel/eve" });
  assert.equal(snapshot.headOid, HEAD);
  assert.equal(githubRequests.length, 2);
});

test("rejects the removed github.org option instead of dropping it", () => {
  const legacy = { connector: "github/acme-bot", org: "acme", broker: async () => {} };
  assert.throws(
    // @ts-expect-error `org` is typed as removed, too.
    () => extension({ github: legacy }),
    /Invalid extension config: github\.org: was removed\..*restrict organizations with authorize/u,
  );
});
