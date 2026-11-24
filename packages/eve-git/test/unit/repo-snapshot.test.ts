import assert from "node:assert/strict";
import test from "node:test";

import { refresh, type RepoSnapshotOptions } from "../../extension/lib/repo-snapshot.ts";

const HEAD = "a".repeat(40);

function harness(input: { exitCode?: number; response?: Response; stdout?: string } = {}) {
  const calls = {
    fetches: [] as { headers: Record<string, string>; url: string }[],
    installs: 0,
    policies: [] as unknown[],
    revisions: [] as string[],
    runs: [] as { command: string; workingDirectory?: string }[],
    tokenRequests: [] as { connector: string; options: unknown }[],
  };
  const sandbox = {
    async run(options: { command: string; workingDirectory?: string }) {
      calls.runs.push(options);
      return { exitCode: input.exitCode ?? 0, stderr: "fatal: bad", stdout: input.stdout ?? "" };
    },
    async setNetworkPolicy(policy: unknown) {
      calls.policies.push(policy);
    },
  };
  const dependencies = {
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.fetches.push({ headers: init?.headers as Record<string, string>, url: String(url) });
      return input.response ?? new Response(`${HEAD}\n`);
    },
    getToken: (async (connector: string, options: unknown) => {
      calls.tokenRequests.push({ connector, options });
      return "ghs_token";
    }) as never,
    rebuild: (async (rebuildInput: {
      prepare: (sandbox: never) => Promise<void>;
      revision: string;
    }) => {
      calls.revisions.push(rebuildInput.revision);
      await rebuildInput.prepare(sandbox as never);
      return { rebuilt: true };
    }) as never,
  };
  const options: RepoSnapshotOptions = {
    connector: "github/app",
    directory: "/workspace/front",
    install: async () => {
      calls.installs += 1;
    },
    repository: "vercel/front",
  };
  return { calls, dependencies, options };
}

test("reads the head with a read-only installation token and rebuilds at that revision", async () => {
  const { calls, dependencies, options } = harness();

  assert.deepEqual(await refresh(options, dependencies), { head: HEAD, rebuilt: true });

  assert.deepEqual(calls.tokenRequests, [
    {
      connector: "github/app",
      options: {
        authorizationDetails: [
          {
            org: "vercel",
            permissions: ["contents:read"],
            repositories: ["front"],
            type: "github_app_installation",
          },
        ],
        subject: { type: "app" },
      },
    },
  ]);
  assert.equal(calls.fetches[0]?.url, "https://api.github.com/repos/vercel/front/commits/main");
  assert.equal(calls.fetches[0]?.headers.authorization, "Bearer ghs_token");
  assert.match(calls.revisions[0] ?? "", new RegExp(`^${HEAD}-[0-9a-f]{12}$`, "u"));
});

test("labels the template by repository, branch and directory as well as the commit", async () => {
  const labels = new Set<string>();
  for (const change of [{}, { branch: "release/1" }, { directory: "/workspace/other" }]) {
    const { calls, dependencies, options } = harness();
    await refresh({ ...options, ...change }, dependencies);
    labels.add(calls.revisions[0] ?? "");
  }
  assert.equal(labels.size, 3);
});

test("fetches the head inside the checkout through the firewall, never putting the token in a command", async () => {
  const { calls, dependencies, options } = harness();

  await refresh({ ...options, branch: "release/1" }, dependencies);

  assert.match(calls.fetches[0]?.url ?? "", /commits\/release\/1$/u);
  assert.equal(calls.runs[0]?.workingDirectory, "/workspace/front");
  assert.match(
    calls.runs[0]?.command ?? "",
    new RegExp(
      `git fetch --no-tags 'https://github.com/vercel/front.git' '\\+${HEAD}:refs/remotes/origin/release/1'`,
      "u",
    ),
  );
  assert.doesNotMatch(calls.runs[0]?.command ?? "", /ghs_token/u);
  assert.match(JSON.stringify(calls.policies[0]), /Basic /u);
});

test("installs only when a lockfile changed", async () => {
  const unchanged = harness();
  await refresh(unchanged.options, unchanged.dependencies);
  assert.equal(unchanged.calls.installs, 0);

  const changed = harness({ stdout: "lockfile-changed\n" });
  await refresh(changed.options, changed.dependencies);
  assert.equal(changed.calls.installs, 1);
});

test("drops the GitHub token from the sandbox before install runs", async () => {
  const { calls, dependencies, options } = harness({ stdout: "lockfile-changed\n" });
  const policiesAtInstall: unknown[][] = [];
  await refresh(
    {
      ...options,
      install: async () => {
        policiesAtInstall.push([...calls.policies]);
      },
    },
    dependencies,
  );

  assert.equal(policiesAtInstall.length, 1);
  assert.equal(policiesAtInstall[0]?.at(-1), "allow-all");
  assert.doesNotMatch(JSON.stringify(policiesAtInstall[0]?.at(-1)), /Basic /u);
});

test("fails on a git error from the lockfile check instead of reading it as a change", async () => {
  const { calls, dependencies, options } = harness();
  await refresh(options, dependencies);

  const command = calls.runs[0]?.command ?? "";
  assert.match(command, /git diff --quiet "\$previous" '[a]{40}' -- 'pnpm-lock.yaml'/u);
  assert.match(command, /\|\| status=\$\?/u);
  assert.match(command, /elif \[ "\$status" -ne 0 \]; then exit "\$status"/u);
});

test("skips the lockfile check when there is no install or no lockfile to watch", async () => {
  const withoutInstall = harness();
  await refresh({ ...withoutInstall.options, install: undefined }, withoutInstall.dependencies);
  assert.doesNotMatch(withoutInstall.calls.runs[0]?.command ?? "", /git diff/u);

  const withoutLockfiles = harness();
  await refresh({ ...withoutLockfiles.options, lockfiles: [] }, withoutLockfiles.dependencies);
  assert.doesNotMatch(withoutLockfiles.calls.runs[0]?.command ?? "", /git diff/u);
  assert.equal(withoutLockfiles.calls.installs, 0);
});

test("fails the rebuild when the sandbox fetch fails, so the template never moves", async () => {
  const { calls, dependencies, options } = harness({ exitCode: 128 });

  await assert.rejects(refresh(options, dependencies), /exit code 128: fatal: bad/u);
  assert.equal(calls.installs, 0);
});

test("rejects a GitHub error and a response that is not a commit sha", async () => {
  const missing = harness({ response: new Response("nope", { status: 404 }) });
  await assert.rejects(refresh(missing.options, missing.dependencies), /404/u);
  assert.deepEqual(missing.calls.revisions, []);

  const html = harness({ response: new Response("<html>") });
  await assert.rejects(refresh(html.options, html.dependencies), /not a commit sha/u);
  assert.deepEqual(html.calls.revisions, []);
});

test("rejects a repository that is not owner/name before calling Connect", async () => {
  const { calls, dependencies, options } = harness();

  await assert.rejects(refresh({ ...options, repository: "front" }, dependencies), /owner\/name/u);
  assert.deepEqual(calls.tokenRequests, []);
});
