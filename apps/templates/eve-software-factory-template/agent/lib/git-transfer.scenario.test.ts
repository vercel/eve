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
const { fetchRepository } = await import("./github/git-transfer.js");
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
    { getSandbox: async () => station }
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

test("push refuses the configured default branch even when it has the factory prefix", async () => {
  mock.method(globalThis, "fetch", async () =>
    Response.json({ default_branch: "factory/default" })
  );
  await assert.rejects(
    pushTool.execute(
      { branch: "factory/default" },
      { getSandbox: async () => station }
    ),
    DEFAULT_BRANCH_ERROR
  );
  assert.equal(stopped, 2);
});
