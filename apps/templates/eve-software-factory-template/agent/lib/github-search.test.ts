import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.FACTORY_REPO = "acme/widgets";
process.env.LINEAR_CONNECTOR = "linear/test";
process.env.GITHUB_CONNECTOR = "github/search-scope-test";
// The real Connect credential helper checks OIDC expiry before minting.
process.env.VERCEL_OIDC_TOKEN = `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.test`;

// Supply eve's mount/config context, but run the actual extension, SDK and Connect client.
mock.module("eve/extension", {
  namedExports: {
    defineExtension: ({ config: schema }: any) => {
      const mount = (config: unknown) => {
        mount.config = schema.parse(config);
        return mount;
      };
      mount.config = undefined as any;
      return mount;
    },
  },
});
mock.module("eve/tools", {
  namedExports: {
    defineDynamic: (factory: unknown) => factory,
    defineTool: (tool: unknown) => tool,
    toolOutput: (output: unknown) => output,
  },
});

const tokenRequests: any[] = [];
const searches: URL[] = [];
mock.method(
  globalThis,
  "fetch",
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.includes("/v1/connect/token/")) {
      tokenRequests.push(JSON.parse(String(init?.body)));
      // Expire immediately so each call proves its own token request, not a cache hit.
      return Promise.resolve(
        Response.json({ expiresAt: 0, token: "test-installation-token" })
      );
    }
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(["/search/code", "/search/issues"].includes(url.pathname));
    searches.push(url);
    return Promise.resolve(Response.json({ items: [], total_count: 0 }));
  }
);

await import("../extensions/github.js");
const credentialsModule = await import("./github/credentials.js");
const { githubChannelCredentials, githubCredentials } = credentialsModule;
const extensionTools = await import("@github-tools/eve-extension/tools");
const discover: any = extensionTools.github;
const session = { auth: { current: null }, id: "search-scope" };
const tools = await discover({ messages: () => Promise.resolve([]), session });

test("channel credentials and isolated Git transfers request only the configured repository", async () => {
  for (const [credentials, permissions] of [
    [
      githubChannelCredentials,
      ["metadata:read", "issues:write", "pull_requests:write"],
    ],
    [githubCredentials, undefined],
  ] as const) {
    const token = credentials.installationToken;
    assert.equal(typeof token, "function");
    // biome-ignore lint/performance/noAwaitInLoops: inspect each distinct credential request
    await (token as () => Promise<string>)();
    assert.deepEqual(tokenRequests.at(-1).authorizationDetails, [
      {
        ...(permissions ? { permissions } : {}),
        repositories: ["acme/widgets"],
        type: "github_app_installation",
      },
    ]);
  }
});

for (const name of ["searchCode", "searchIssues"]) {
  for (const query of [
    "repo:other/private factory",
    "factory",
    "repo:acme/widgets factory",
  ]) {
    test(`${name} confines its token request to the factory repository for '${query}'`, async () => {
      const before = tokenRequests.length;
      const result = await tools[name].execute(
        tools[name].inputSchema.parse({ query }),
        { session }
      );
      assert.deepEqual(result, { items: [], totalCount: 0 });
      assert.equal(tokenRequests.length, before + 1);
      assert.deepEqual(tokenRequests.at(-1).subject, { type: "app" });
      assert.deepEqual(tokenRequests.at(-1).authorizationDetails, [
        {
          repositories: ["acme/widgets"],
          type: "github_app_installation",
        },
      ]);
      assert.equal(searches.at(-1)?.searchParams.get("q"), query);
    });
  }
}
