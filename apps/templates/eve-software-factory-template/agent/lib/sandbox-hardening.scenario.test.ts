import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const EGRESS_HINT = /FACTORY_SANDBOX_ALLOWED_DOMAINS/;
const INVALID_HOST = /not a hostname/;
const root = await mkdtemp(join(tmpdir(), "factory-setup-"));
after(() => rm(root, { force: true, recursive: true }));
process.env.FACTORY_REPO = "acme/widgets";
process.env.LINEAR_CONNECTOR = "linear/test";
process.env.FACTORY_BOT_NAME = "foreman";
process.env.FACTORY_SETUP_COMMAND =
  "npm install --offline --no-audit --no-fund";
mock.module("./github/git-transfer.js", {
  namedExports: { fetchRepository: () => Promise.resolve("head") },
});
mock.module("@vercel/connect/eve", {
  namedExports: { connect: () => ({}), connectGitHubCredentials: () => ({}) },
});
const { basePolicy } = await import("./github/egress.js");
const { factoryInit } = await import("./github/repo-sandbox.js");
const sandbox = {
  run: async ({ command }: { command: string }) => {
    try {
      const { stdout, stderr } = await exec("/bin/sh", ["-c", command], {
        cwd: root,
        env: {
          HOME: root,
          PATH: process.env.PATH,
          XDG_CONFIG_HOME: join(root, ".config"),
        },
      });
      return { exitCode: 0, stderr, stdout };
    } catch (error: any) {
      return { exitCode: 1, stderr: error.stderr, stdout: error.stdout };
    }
  },
};

test("station setup suppresses automatic npm scripts, preserves explicit build scripts, and is repeatable", async () => {
  await mkdir(join(root, "repo"));
  await writeFile(
    join(root, "repo/package.json"),
    JSON.stringify({
      name: "setup-fixture",
      scripts: {
        build: "node -e \"require('fs').writeFileSync('built', 'yes')\"",
        install: "node -e \"require('fs').writeFileSync('installed', 'yes')\"",
      },
      version: "1.0.0",
    })
  );
  delete process.env.FACTORY_ALLOW_INSTALL_SCRIPTS;
  await factoryInit(sandbox as any);
  await factoryInit(sandbox as any);
  await assert.rejects(readFile(join(root, "repo/installed")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(join(root, ".npmrc"), "utf8"),
    "ignore-scripts=true\n"
  );
  assert.equal(
    await readFile(join(root, ".config/pnpm/config.yaml"), "utf8"),
    "ignoreScripts: true\n"
  );
  assert.equal(
    (await sandbox.run({ command: "cd repo && npm run build" })).exitCode,
    0
  );
  assert.equal(await readFile(join(root, "repo/built"), "utf8"), "yes");

  process.env.FACTORY_SETUP_COMMAND = "exit 1";
  await assert.rejects(factoryInit(sandbox as any), EGRESS_HINT);
});

test("factory egress defaults to exact hosts and refuses accidental wildcard or URL configuration", () => {
  delete process.env.FACTORY_SANDBOX_EGRESS;
  delete process.env.FACTORY_SANDBOX_ALLOWED_DOMAINS;
  const policy = basePolicy() as any;
  assert.deepEqual(policy.allow["github.com"], []);
  assert.deepEqual(policy.allow["registry.npmjs.org"], []);
  assert.equal(policy.allow["*"], undefined);
  for (const value of [
    "*.example.com",
    "https://example.com",
    "example.com:443",
    "127.0.0.1",
  ]) {
    process.env.FACTORY_SANDBOX_ALLOWED_DOMAINS = value;
    assert.throws(basePolicy, INVALID_HOST);
  }
  process.env.FACTORY_SANDBOX_ALLOWED_DOMAINS =
    " Registry.Example.com,registry.example.com ";
  assert.deepEqual((basePolicy() as any).allow["registry.example.com"], []);
  process.env.FACTORY_SANDBOX_EGRESS = "typo";
  assert.equal((basePolicy() as any).allow["*"], undefined);
  process.env.FACTORY_SANDBOX_EGRESS = "open";
  assert.equal(basePolicy(), "allow-all");
});
