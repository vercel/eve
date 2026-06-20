import { execFile, spawn } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { CODING_AGENT_ENV_MARKERS } from "../../src/cli/agent-detection.js";
import { DEFAULT_AGENT_MODEL_ID } from "../../src/shared/default-agent-model.js";
import { pathExists } from "../../src/setup/path-exists.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const EVE_BIN_PATH = fileURLToPath(new URL("../../bin/eve.js", import.meta.url));
const runFile = promisify(execFile);

const createScratchDirectory = useTemporaryDirectories();

interface BinResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runEveBin(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<BinResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [EVE_BIN_PATH, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
  });
}

interface PackageManagerCall {
  args: string[];
  cwd: string;
}

/**
 * These scenarios spawn the real CLI, and the test runner itself is often
 * launched by a coding agent whose markers would flip `eve init` onto the
 * agent path. Human-path scenarios start from a scrubbed environment;
 * agent-path scenarios add `AI_AGENT` back explicitly.
 */
function withoutCodingAgentMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const marker of CODING_AGENT_ENV_MARKERS) {
    delete scrubbed[marker];
  }
  return scrubbed;
}

async function createFakePnpmEnvironment(scratch: string): Promise<{
  env: NodeJS.ProcessEnv;
  readCalls(): Promise<PackageManagerCall[]>;
}> {
  const fakePnpmPath = join(scratch, "fake-pnpm.cjs");
  const logPath = join(scratch, "pnpm-calls.jsonl");
  await writeFile(
    fakePnpmPath,
    [
      'const { appendFileSync, writeFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      "const args = process.argv.slice(2);",
      "appendFileSync(",
      "  process.env.EVE_INIT_PNPM_LOG,",
      "  `${JSON.stringify({ args, cwd: process.cwd() })}\\n`,",
      ");",
      'if (args.includes("install")) {',
      '  writeFileSync(join(process.cwd(), "pnpm-lock.yaml"), "lockfileVersion: 9.0\\n");',
      "}",
    ].join("\n"),
  );

  const { PNPM_HOME: _pnpmHome, ...baseEnv } = process.env;
  const env = {
    ...withoutCodingAgentMarkers(baseEnv),
    EVE_INIT_PNPM_LOG: logPath,
    GIT_AUTHOR_EMAIL: "eve-init@example.com",
    GIT_AUTHOR_NAME: "eve Init",
    GIT_COMMITTER_EMAIL: "eve-init@example.com",
    GIT_COMMITTER_NAME: "eve Init",
    npm_execpath: fakePnpmPath,
  };

  return {
    env,
    async readCalls() {
      const content = await readFile(logPath, "utf8");
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PackageManagerCall);
    },
  };
}

async function createFakeNpmEnvironment(scratch: string): Promise<{
  env: NodeJS.ProcessEnv;
  readCalls(): Promise<PackageManagerCall[]>;
}> {
  const fakeNpmPath = join(scratch, "fake-npm.cjs");
  const logPath = join(scratch, "npm-calls.jsonl");
  await writeFile(
    fakeNpmPath,
    [
      'const { appendFileSync, writeFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      "const args = process.argv.slice(2);",
      "appendFileSync(",
      "  process.env.EVE_INIT_NPM_LOG,",
      "  `${JSON.stringify({ args, cwd: process.cwd() })}\\n`,",
      ");",
      'if (args.includes("install")) {',
      '  writeFileSync(join(process.cwd(), "package-lock.json"), "{}\\n");',
      "}",
    ].join("\n"),
  );

  const { PNPM_HOME: _pnpmHome, ...baseEnv } = process.env;
  const env = {
    ...withoutCodingAgentMarkers(baseEnv),
    EVE_INIT_NPM_LOG: logPath,
    GIT_AUTHOR_EMAIL: "eve-init@example.com",
    GIT_AUTHOR_NAME: "eve Init",
    GIT_COMMITTER_EMAIL: "eve-init@example.com",
    GIT_COMMITTER_NAME: "eve Init",
    npm_config_user_agent: "npm/11.0.0 node/v24.0.0 darwin arm64",
    npm_execpath: fakeNpmPath,
  };

  return {
    env,
    async readCalls() {
      const content = await readFile(logPath, "utf8");
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PackageManagerCall);
    },
  };
}

describe("eve init smoke", () => {
  it("creates the base template with the default model and no Vercel state", async () => {
    const scratch = await createScratchDirectory("eve-init-");
    const fakePnpm = await createFakePnpmEnvironment(scratch);

    const result = await runEveBin(scratch, ["init", "smoke-agent"], fakePnpm.env);

    expect(result.exitCode, result.stderr).toBe(0);

    const projectDir = join(scratch, "smoke-agent");
    const canonicalProjectDir = await realpath(projectDir);
    const agentSource = await readFile(join(projectDir, "agent/agent.ts"), "utf8");
    const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    expect(agentSource).toContain(DEFAULT_AGENT_MODEL_ID);
    expect(packageJson.engines?.node).toBe("24.x");
    expect(await readFile(join(projectDir, "pnpm-workspace.yaml"), "utf8")).toContain(
      '"eve@>=0.6.0-beta.13 <=0.7.0":',
    );
    await expect(pathExists(join(projectDir, "app"))).resolves.toBe(false);
    await expect(pathExists(join(projectDir, ".vercel"))).resolves.toBe(false);
    await expect(pathExists(join(projectDir, "vercel.json"))).resolves.toBe(false);
    expect(await fakePnpm.readCalls()).toEqual([
      {
        args: [
          "--dir",
          canonicalProjectDir,
          "install",
          "--no-frozen-lockfile",
          "--config.minimum-release-age=0",
        ],
        cwd: canonicalProjectDir,
      },
      {
        args: ["--dir", canonicalProjectDir, "exec", "eve", "dev", "--input", "/model"],
        cwd: canonicalProjectDir,
      },
    ]);
    expect(result.stdout).toContain("Created an eve agent in ");
    expect(result.stdout).toContain("Preparing project...");
    expect(result.stdout).toContain("Installed dependencies");
    expect(result.stdout).not.toContain("Progress: resolved");
    await expect(pathExists(join(projectDir, ".git"))).resolves.toBe(true);
    await expect(
      runFile("git", ["log", "-1", "--pretty=%s"], { cwd: projectDir }),
    ).resolves.toMatchObject({ stdout: "Initial commit from eve\n" });
    await expect(
      runFile("git", ["ls-files", "--error-unmatch", "pnpm-lock.yaml"], { cwd: projectDir }),
    ).resolves.toMatchObject({ stdout: "pnpm-lock.yaml\n" });
    await expect(
      runFile("git", ["status", "--porcelain"], { cwd: projectDir }),
    ).resolves.toMatchObject({ stdout: "" });
  });

  it("adds Web Chat without Vercel configuration", async () => {
    const scratch = await createScratchDirectory("eve-init-web-");
    const fakePnpm = await createFakePnpmEnvironment(scratch);

    const result = await runEveBin(
      scratch,
      ["init", "web-agent", "--channel-web-nextjs"],
      fakePnpm.env,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const projectDir = join(scratch, "web-agent");
    await expect(pathExists(join(projectDir, "app/page.tsx"))).resolves.toBe(true);
    await expect(pathExists(join(projectDir, "vercel.json"))).resolves.toBe(false);
    expect(await readFile(join(projectDir, "next.config.ts"), "utf8")).toContain(
      "export default withEve(nextConfig);",
    );
    const [installCall, devCall] = await fakePnpm.readCalls();
    expect(installCall?.args.slice(-3)).toEqual([
      "install",
      "--no-frozen-lockfile",
      "--config.minimum-release-age=0",
    ]);
    expect(devCall?.args.slice(-5)).toEqual(["exec", "eve", "dev", "--input", "/model"]);
  });

  it("adds Web Chat through npm without writing pnpm configuration", async () => {
    const scratch = await createScratchDirectory("eve-init-web-npm-");
    const fakeNpm = await createFakeNpmEnvironment(scratch);

    const result = await runEveBin(
      scratch,
      ["init", "web-agent", "--channel-web-nextjs"],
      fakeNpm.env,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const projectDir = join(scratch, "web-agent");
    const canonicalProjectDir = await realpath(projectDir);
    await expect(pathExists(join(projectDir, "app/page.tsx"))).resolves.toBe(true);
    await expect(pathExists(join(projectDir, "pnpm-workspace.yaml"))).resolves.toBe(false);
    await expect(pathExists(join(projectDir, "package-lock.json"))).resolves.toBe(true);
    expect(await fakeNpm.readCalls()).toEqual([
      {
        args: ["install", "--min-release-age=0"],
        cwd: canonicalProjectDir,
      },
      {
        args: ["exec", "--", "eve", "dev", "--input", "/model"],
        cwd: canonicalProjectDir,
      },
    ]);
  });

  it("adds an agent to an existing pnpm project targeted as a directory", async () => {
    const scratch = await createScratchDirectory("eve-init-dir-");
    const fakePnpm = await createFakePnpmEnvironment(scratch);
    await writeFile(
      join(scratch, "package.json"),
      `${JSON.stringify(
        {
          name: "host-app",
          dependencies: { zod: "^3.25.0" },
          engines: { node: ">=24" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(scratch, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");

    const result = await runEveBin(scratch, ["init", "."], fakePnpm.env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Added an eve agent to ");
    const agentSource = await readFile(join(scratch, "agent/agent.ts"), "utf8");
    expect(agentSource).toContain(DEFAULT_AGENT_MODEL_ID);
    await expect(pathExists(join(scratch, "agent/instructions.md"))).resolves.toBe(true);
    expect(JSON.parse(await readFile(join(scratch, "package.json"), "utf8"))).toMatchObject({
      dependencies: { zod: "^3.25.0" },
      engines: { node: "24.x" },
    });
    expect(result.stdout).toContain('Overrode package.json engines.node from ">=24" to "24.x"');
    expect(await readFile(join(scratch, "pnpm-workspace.yaml"), "utf8")).toContain(
      '"eve@>=0.6.0-beta.13 <=0.7.0":',
    );
    expect((await fakePnpm.readCalls()).map((call) => call.args.slice(-3))).toEqual([
      ["install", "--no-frozen-lockfile", "--config.minimum-release-age=0"],
      ["exec", "eve", "dev"],
    ]);
  });

  it("scaffolds the current empty directory for a coding agent that omits the target", async () => {
    const scratch = await createScratchDirectory("eve-init-agent-bare-");
    const fakePnpmRoot = await createScratchDirectory("eve-init-agent-bare-pnpm-");
    const fakePnpm = await createFakePnpmEnvironment(fakePnpmRoot);

    const result = await runEveBin(scratch, ["init"], { ...fakePnpm.env, AI_AGENT: "claude" });

    expect(result.exitCode, result.stderr).toBe(0);
    const canonicalProjectDir = await realpath(scratch);
    expect(await readFile(join(scratch, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    expect(await fakePnpm.readCalls()).toEqual([
      {
        args: [
          "--dir",
          canonicalProjectDir,
          "install",
          "--no-frozen-lockfile",
          "--config.minimum-release-age=0",
        ],
        cwd: canonicalProjectDir,
      },
    ]);
    expect(result.stdout).toContain("Do not start `eve dev`");
  });

  it("scaffolds the current empty directory when the target is omitted", async () => {
    const scratch = await createScratchDirectory("eve-init-human-bare-");
    const fakePnpmRoot = await createScratchDirectory("eve-init-human-bare-pnpm-");
    const fakePnpm = await createFakePnpmEnvironment(fakePnpmRoot);

    const result = await runEveBin(scratch, ["init"], fakePnpm.env);

    expect(result.exitCode, result.stderr).toBe(0);
    const canonicalProjectDir = await realpath(scratch);
    expect(await readFile(join(scratch, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    await expect(pathExists(join(scratch, ".git"))).resolves.toBe(true);
    expect(await fakePnpm.readCalls()).toEqual([
      {
        args: [
          "--dir",
          canonicalProjectDir,
          "install",
          "--no-frozen-lockfile",
          "--config.minimum-release-age=0",
        ],
        cwd: canonicalProjectDir,
      },
      {
        args: ["--dir", canonicalProjectDir, "exec", "eve", "dev", "--input", "/model"],
        cwd: canonicalProjectDir,
      },
    ]);
  });

  it("scaffolds for a coding agent but prints the dev command instead of starting the TUI", async () => {
    const scratch = await createScratchDirectory("eve-init-agent-named-");
    const fakePnpm = await createFakePnpmEnvironment(scratch);

    const result = await runEveBin(scratch, ["init", "smoke-agent"], {
      ...fakePnpm.env,
      AI_AGENT: "claude",
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const projectDir = join(scratch, "smoke-agent");
    const canonicalProjectDir = await realpath(projectDir);
    expect(await readFile(join(projectDir, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    await expect(pathExists(join(projectDir, ".git"))).resolves.toBe(true);
    // Install runs through the real binary, but the dev server is handed off as
    // text rather than spawned: the only install call is the install itself,
    // and the handoff's "Do not start" line is the anchor that the TUI never
    // launched. The handoff's command text is the unit test's job.
    expect(await fakePnpm.readCalls()).toEqual([
      {
        args: [
          "--dir",
          canonicalProjectDir,
          "install",
          "--no-frozen-lockfile",
          "--config.minimum-release-age=0",
        ],
        cwd: canonicalProjectDir,
      },
    ]);
    expect(result.stdout).toContain("Do not start `eve dev`");
  });

  it("rejects path-like names without writing outside the current directory", async () => {
    const scratch = await createScratchDirectory("eve-init-invalid-name-");
    const escapedName = `${basename(scratch)}-escaped`;
    const escapedPath = join(scratch, "..", escapedName);

    const result = await runEveBin(scratch, ["init", `../${escapedName}`]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Project name can only contain");
    await expect(pathExists(escapedPath)).resolves.toBe(false);
  });
});
