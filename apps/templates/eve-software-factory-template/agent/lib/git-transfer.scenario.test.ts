// biome-ignore-all lint/performance/noAwaitInLoops: real Git and shared broker state require sequential assertions
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "factory-transfer-"));
after(() => rm(root, { force: true, recursive: true }));
const remotePath = join(root, "remote.git");
const stationPath = join(root, "station");
const marker = join(root, "hook-ran");
const DEFAULT_BRANCH_ERROR = /default branch/;
const PR_LOOKUP_ERROR = /pull request/;
process.env.FACTORY_REPO = "acme/widgets";
process.env.LINEAR_CONNECTOR = "linear/test";
mock.module("@vercel/connect/eve", {
  namedExports: {
    connect: () => ({}),
    connectGitHubCredentials: () => ({ installationToken: "test-token" }),
  },
});
const gitRemote = await import("./github/git-remote.js");
mock.module("./github/git-remote.js", {
  namedExports: { ...gitRemote, REMOTE_URL: remotePath, REPO_DIR: stationPath },
});
mock.module("eve/tools", {
  namedExports: { defineTool: (config: unknown) => config },
});
mock.module("../subagents/implementer/sandbox.js", {
  namedExports: { environment: {} },
});
let stopped = 0;
let afterImport: (() => void) | undefined;
// Provision a fresh local workspace instead of a Vercel VM. All Git commands
// still execute, and only the object bundle is copied from the hostile station.
mock.module("@vercel/sandbox", {
  namedExports: {
    Sandbox: {
      create: async () => {
        const directory = await mkdtemp(join(root, "isolated-"));
        const map = (path: string) =>
          path
            .replaceAll("/tmp/factory.git", join(directory, "factory.git"))
            .replaceAll(
              "/tmp/transfer.bundle",
              join(directory, "transfer.bundle")
            );
        return {
          readFile: async ({ path }: { path: string }) =>
            createReadStream(map(path)),
          runCommand: async (command: string, args: string[]) => {
            try {
              const { stdout } = await exec(command, args.map(map), {
                cwd: directory,
              });
              if (args.includes("fetch")) {
                afterImport?.();
              }
              return { exitCode: 0, stdout: async () => stdout };
            } catch {
              return { exitCode: 1, stdout: async () => "" };
            }
          },
          stop: () => {
            stopped += 1;
            return Promise.resolve();
          },
          updateNetworkPolicy: () => Promise.resolve(),
          writeFiles: async (
            files: { path: string; content: Uint8Array }[]
          ) => {
            await Promise.all(
              files.map((file) => writeFile(map(file.path), file.content))
            );
          },
        };
      },
    },
  },
});
const pusher = await import("../subagents/implementer/tools/push_branch.js");
const pushTool = pusher.default as any;
const transfer = await import("./github/git-transfer.js");
const { fetchRepository, pushBranch } = transfer;
const { autonomousForTicket, ticketBranch, stampTrusted, stampAutonomous } =
  await import("./trust.js");
mock.method(globalThis, "fetch", async (url: string) =>
  Response.json(
    url.includes("/branches/")
      ? { protected: false }
      : { default_branch: "main" }
  )
);
const git = (...args: string[]) => exec("git", args, { cwd: root });
const station = {
  readFile: async ({ path }: { path: string }) =>
    new Response(await readFile(path)).body,
  run: async ({ command }: { command: string }) => {
    const { stdout, stderr } = await exec("/bin/sh", ["-c", command], {
      cwd: root,
    });
    return { exitCode: 0, stderr, stdout };
  },
  setNetworkPolicy: () => {
    throw new Error("Repository code must never receive brokered credentials");
  },
  writeBinaryFile: async ({
    path,
    content,
  }: {
    path: string;
    content: Uint8Array;
  }) => writeFile(path, content),
};

test("push entry point transfers only the validated feature ref despite hostile hooks and config", async () => {
  await git("init", "--bare", remotePath);
  await git("init", "-b", "main", stationPath);
  await git("-C", stationPath, "config", "user.name", "Alice");
  await git("-C", stationPath, "config", "user.email", "alice@example.test");
  await git(
    "-C",
    stationPath,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "initial"
  );
  await git("-C", stationPath, "push", remotePath, "main");
  await git("--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main");
  const initial = (
    await git("--git-dir", remotePath, "rev-parse", "main")
  ).stdout.trim();
  await git("-C", stationPath, "checkout", "-b", "factory/fix");
  await git(
    "-C",
    stationPath,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fix"
  );
  const head = (
    await git("-C", stationPath, "rev-parse", "HEAD")
  ).stdout.trim();
  const hooks = join(root, "hostile-hooks");
  await mkdir(hooks);
  await writeFile(
    join(hooks, "pre-push"),
    `#!/bin/sh\ntouch '${marker}'\ngit -c core.hooksPath=/dev/null push '${remotePath}' HEAD:refs/heads/main\n`,
    { mode: 0o755 }
  );
  await git("-C", stationPath, "config", "core.hooksPath", hooks);
  await git("-C", stationPath, "config", "push.followTags", "true");
  await git(
    "-C",
    stationPath,
    "tag",
    "-a",
    "unexpected",
    "-m",
    "must not transfer"
  );
  const result = await pushTool.execute(
    { branch: "factory/fix" },
    { getSandbox: async () => station, session: { auth: { current: null } } }
  );
  assert.equal(result.success, true);
  assert.equal(result.sha, head);
  assert.equal(
    (await git("--git-dir", remotePath, "rev-parse", "main")).stdout.trim(),
    initial
  );
  assert.equal(
    (
      await git("--git-dir", remotePath, "rev-parse", "factory/fix")
    ).stdout.trim(),
    head
  );
  assert.equal((await git("--git-dir", remotePath, "tag")).stdout, "");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal(stopped, 1);

  // Download is isolated too: fetching a revision must not lend a token to
  // an existing station with surviving repository processes and config.
  assert.equal(await fetchRepository(station as any, "factory/fix"), head);
  assert.equal(stopped, 2);
});

test("HTTP ticket pushes are confined to their stamped branch and freeze at PR delivery", async (t) => {
  const auth = autonomousForTicket("ticket:alice:work-1");
  const owned = ticketBranch(auth);
  const other = ticketBranch(autonomousForTicket("ticket:bob:work-2"));
  let pulls: () => Response = () => Response.json([]);
  let lookups = 0;
  mock.method(globalThis, "fetch", (url: string) => {
    lookups += 1;
    if (url.includes("/pulls?")) {
      const query = new URL(url).searchParams;
      assert.equal(query.get("head"), `acme:${owned}`);
      assert.equal(query.get("state"), "all");
      return pulls();
    }
    return Response.json(
      url.includes("/branches/")
        ? { protected: false }
        : { default_branch: "main" }
    );
  });
  const context = (current: unknown) => ({
    getSandbox: async () => station,
    session: { auth: { current } },
  });
  const remoteHead = async (branch: string) =>
    (await git("--git-dir", remotePath, "rev-parse", branch)).stdout.trim();
  const commit = async (message: string) => {
    await git(
      "-C",
      stationPath,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      message
    );
    return (await git("-C", stationPath, "rev-parse", "HEAD")).stdout.trim();
  };
  // Both forbidden targets exist and permit a fast-forward: the old
  // prefix-only broker would change these remote refs.
  for (const branch of ["factory/ready", other]) {
    await git("-C", stationPath, "branch", branch, "main");
    await git(
      "-C",
      stationPath,
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      remotePath,
      branch
    );
    await git("-C", stationPath, "branch", "-f", branch, "HEAD");
    const before = await remoteHead(branch);
    const transfers = stopped;
    const requests = lookups;
    await assert.rejects(
      pushTool.execute(
        { branch },
        {
          ...context(auth),
          getSandbox: () =>
            assert.fail("unauthorized branches must not open a station"),
        }
      ),
      {
        message: "HTTP tickets may push only their server-assigned branch.",
      }
    );
    assert.equal(await remoteHead(branch), before);
    assert.equal(stopped, transfers);
    assert.equal(lookups, requests);
  }
  await git("-C", stationPath, "checkout", "-b", owned);
  for (const invalid of [
    { ...auth, attributes: { factoryRepository: "acme/widgets" } },
    {
      ...auth,
      attributes: { ...auth.attributes, ticketBranch: "factory/fix" },
    },
    {
      ...auth,
      attributes: { ...auth.attributes, factoryRepository: "acme/other" },
    },
    { ...auth, principalId: "github:123" },
  ]) {
    await assert.rejects(
      pushTool.execute({ branch: owned }, context(invalid)),
      { message: "HTTP ticket push authority is missing or invalid." }
    );
  }
  await assert.rejects(
    pushTool.execute({ branch: owned }, context(undefined)),
    { message: "Push authentication context is required." }
  );
  await assert.rejects(
    pushBranch(station as any, owned, { ...auth, attributes: {} }),
    { message: "HTTP ticket push authority is missing or invalid." }
  );
  const first = await pushTool.execute({ branch: owned }, context(auth));
  assert.equal(first.success, true);
  assert.equal(await remoteHead(owned), first.sha);
  const revision = await commit("Address reviewer findings before delivery");
  assert.equal(
    (await pushTool.execute({ branch: owned }, context(auth))).sha,
    revision
  );
  assert.equal(await remoteHead(owned), revision);
  await commit("Alice requests a revision after delivery");
  for (const [name, response] of [
    ["ready PR", () => Response.json([{ draft: false, state: "open" }])],
    ["draft PR", () => Response.json([{ draft: true, state: "open" }])],
    ["closed PR", () => Response.json([{ draft: false, state: "closed" }])],
    ["lookup failure", () => new Response("unavailable", { status: 503 })],
    ["malformed data", () => Response.json({ message: "unexpected" })],
    ["invalid JSON", () => new Response("not JSON")],
    [
      "pagination",
      () =>
        Response.json([], {
          headers: { link: '<https://api.github.com/next>; rel="next"' },
        }),
    ],
  ] as const) {
    await t.test(name, async () => {
      pulls = response;
      const transfers = stopped;
      const inertStation = {
        ...station,
        readFile: () => assert.fail("denied push must not read a bundle"),
        run: () => assert.fail("denied push must not export station objects"),
      };
      await assert.rejects(
        pushTool.execute(
          { branch: owned },
          { ...context(auth), getSandbox: async () => inertStation }
        ),
        (error: Error) => {
          assert.notEqual(
            error.name,
            "AssertionError",
            "broker must reject before touching station objects"
          );
          return true;
        }
      );
      assert.equal(await remoteHead(owned), revision);
      assert.equal(stopped, transfers);
    });
  }
  for (const [name, boundary, response] of [
    [
      "PR appears during export",
      "export",
      () => Response.json([{ draft: false, state: "open" }]),
    ],
    [
      "PR appears during import",
      "import",
      () => Response.json([{ draft: false, state: "open" }]),
    ],
    [
      "lookup fails after import",
      "import",
      () => new Response("unavailable", { status: 503 }),
    ],
    ["invalid JSON after import", "import", () => new Response("not JSON")],
    [
      "oversized response after import",
      "import",
      () => new Response(`${" ".repeat(2048)}[]`),
    ],
    [
      "pagination after import",
      "import",
      () =>
        Response.json([], {
          headers: { link: '<https://api.github.com/next>; rel="next"' },
        }),
    ],
  ] as const) {
    await t.test(name, async () => {
      let headLookups = 0;
      pulls = () => {
        headLookups += 1;
        return Response.json([]);
      };
      const freeze = () => {
        assert.equal(headLookups, 1, "early lookup must see no PR");
        pulls = () => {
          headLookups += 1;
          return response();
        };
      };
      afterImport = boundary === "import" ? freeze : undefined;
      const delayedStation = {
        ...station,
        readFile: async (options: { path: string }) => {
          const body = await station.readFile(options);
          if (boundary === "export") {
            freeze();
          }
          return body;
        },
      };
      const transfers = stopped;
      try {
        await assert.rejects(
          pushTool.execute(
            { branch: owned },
            { ...context(auth), getSandbox: async () => delayedStation }
          ),
          PR_LOOKUP_ERROR
        );
        assert.equal(headLookups, 2);
        assert.equal(await remoteHead(owned), revision);
        assert.equal(stopped, transfers + 1, "fresh transfer must be disposed");
      } finally {
        afterImport = undefined;
      }
    });
  }
  // Trusted human/Linear and vetted GitHub label sessions retain revision
  // authority even after delivery; only bearer tickets carry the freeze.
  for (const current of [
    stampTrusted({
      ...auth,
      attributes: { repository: "acme/widgets" },
      authenticator: "github-webhook",
      principalId: "github:123",
    }),
    stampTrusted({
      ...auth,
      attributes: {},
      authenticator: "linear",
      principalId: "linear:alice",
    }),
    stampAutonomous(
      {
        ...auth,
        attributes: { repository: "acme/widgets" },
        authenticator: "github-webhook",
      },
      7
    ),
  ]) {
    const result = await pushTool.execute({ branch: owned }, context(current));
    assert.equal(result.success, true);
    assert.equal(await remoteHead(owned), result.sha);
  }
});

test("push refuses configured default and protected branches even when they have the factory prefix", async () => {
  const transfers = stopped;
  mock.method(globalThis, "fetch", async () =>
    Response.json({ default_branch: "factory/default" })
  );
  await assert.rejects(
    pushTool.execute(
      { branch: "factory/default" },
      { getSandbox: async () => station, session: { auth: { current: null } } }
    ),
    DEFAULT_BRANCH_ERROR
  );
  mock.method(globalThis, "fetch", async (url: string) =>
    Response.json(
      url.includes("/branches/")
        ? { protected: true }
        : { default_branch: "main" }
    )
  );
  await assert.rejects(
    pushTool.execute(
      { branch: "factory/protected" },
      { getSandbox: async () => station, session: { auth: { current: null } } }
    ),
    { message: "Protected branches cannot be pushed by the factory." }
  );
  assert.equal(stopped, transfers);
});
