import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { CODING_AGENT_ENV_MARKERS } from "../../src/cli/agent-detection.js";
import { stripAnsi } from "../../src/cli/ui/terminal-text.js";
import { loadYaml } from "../../src/evals/loaders/yaml.js";
import { DEFAULT_AGENT_MODEL_ID } from "../../src/shared/default-agent-model.js";
import { pathExists } from "../../src/setup/path-exists.js";
import { eveDevArguments } from "../../src/setup/primitives/run-pnpm.js";
import { ensureScenarioEveTarballPath } from "../../src/internal/testing/scenario-app.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const EVE_BIN_PATH = fileURLToPath(new URL("../../bin/eve.js", import.meta.url));
const runFile = promisify(execFile);
const RELEASE_AGE_MINUTES = 100_000_000;
const PNPM_INIT_INSTALL_ARGUMENTS = [
  "install",
  "--no-frozen-lockfile",
  "--yes",
  "--config.minimum-release-age=0",
] as const;

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
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
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

describe("eve init smoke", () => {
  it("installs and runs a standalone pnpm scaffold under an inherited release-age policy", async () => {
    const scratch = await createScratchDirectory("eve-init-release-age-");
    const eveTarball = `file:${await ensureScenarioEveTarballPath()}`;
    const pnpmfile = join(scratch, "scaffold-pnpmfile.cjs");
    // The package under test need not have reached npm; registry dependencies still use the policy.
    await writeFile(
      pnpmfile,
      [
        "module.exports = { hooks: { updateConfig(config) {",
        `  return { ...config, overrides: { ...config.overrides, eve: ${JSON.stringify(eveTarball)} } };`,
        "} } };\n",
      ].join("\n"),
    );
    const configHome = join(scratch, "config");
    await mkdir(join(configHome, "pnpm"), { recursive: true });
    await writeFile(
      join(configHome, "pnpm", "config.yaml"),
      `minimumReleaseAge: ${RELEASE_AGE_MINUTES}\nverifyDepsBeforeRun: install\n`,
    );
    const env = {
      ...withoutCodingAgentMarkers(process.env),
      // Exercise the package-manager dev handoff separately without opening a TUI.
      AI_AGENT: "claude",
      CI: "true",
      PNPM_CONFIG_GLOBAL_PNPMFILE: pnpmfile,
      XDG_CONFIG_HOME: configHome,
    };

    const result = await runEveBin(scratch, ["init", "policy-agent"], env);

    expect(result.exitCode, result.stderr).toBe(0);
    const projectDir = join(scratch, "policy-agent");
    await expect(readFile(join(projectDir, "pnpm-workspace.yaml"), "utf8")).resolves.not.toContain(
      "minimumReleaseAgeExclude:",
    );
    await expect(readFile(join(projectDir, "pnpm-workspace.yaml"), "utf8")).resolves.toContain(
      "minimumReleaseAgeStrict: true",
    );

    // pnpm checks the installed lockfile before exec/run and may reinstall.
    // A one-time install flag must not leave the next command rejecting it.
    const devArguments = ["--reporter=silent", ...eveDevArguments("pnpm")];
    const dev = await runFile("pnpm", [...devArguments, "--help"], {
      cwd: projectDir,
      env,
    });
    expect(dev.stdout).toContain("Usage: eve dev");
    expect(dev.stdout).not.toMatch(/Lockfile|Already up to date|Done in/u);
    await expect(
      runFile("pnpm", [...devArguments, "--unknown-init-test-option"], {
        cwd: projectDir,
        env,
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("unknown option") });
    await expect(
      runFile("pnpm", ["install", "--frozen-lockfile"], { cwd: projectDir, env }),
    ).resolves.toMatchObject({ stdout: expect.any(String) });

    // Exercise the unpublished eve override independently of the initial
    // scaffold install's release-age bypass.
    const manifestPath = join(projectDir, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies.eve = "0.0.0-eve-init-unpublished";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(
      runFile(
        "pnpm",
        [
          "add",
          "--ignore-scripts",
          "--lockfile-only",
          "--config.minimum-release-age=0",
          "is-number@7.0.0",
        ],
        { cwd: projectDir, env },
      ),
    ).resolves.toMatchObject({ stderr: expect.any(String) });
    const lockfile = (await loadYaml(join(projectDir, "pnpm-lock.yaml"))) as {
      overrides?: Record<string, string>;
    };
    expect(lockfile.overrides?.eve).toBe(eveTarball);
  });

  it("creates the base template with the default model and no Vercel state", async () => {
    const scratch = await createScratchDirectory("eve-init-");
    const fakePnpm = await createFakePnpmEnvironment(scratch);

    const result = await runEveBin(scratch, ["init", "smoke-agent"], fakePnpm.env);

    expect(result.exitCode, result.stderr).toBe(0);

    const projectDir = join(scratch, "smoke-agent");
    const canonicalProjectDir = await realpath(projectDir);
    const agentSource = await readFile(join(projectDir, "agent/agent.ts"), "utf8");
    const readme = await readFile(join(projectDir, "README.md"), "utf8");
    expect(readme).toContain("# smoke-agent");
    expect(readme).toContain("## Getting started");
    expect(readme).toContain("eve dev");
    expect(readme).toContain("## Learn more");
    expect(readme).toContain("## Deploy on Vercel");
    expect(readme).toContain("eve deploy");
    const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    expect(agentSource).toContain(DEFAULT_AGENT_MODEL_ID);
    expect(packageJson.engines?.node).toBe("24.x");
    await expect(readFile(join(projectDir, "pnpm-workspace.yaml"), "utf8")).resolves.toContain(
      "minimumReleaseAgeStrict: true",
    );
    await expect(pathExists(join(projectDir, "app"))).resolves.toBe(false);
    await expect(pathExists(join(projectDir, ".vercel"))).resolves.toBe(false);
    await expect(pathExists(join(projectDir, "vercel.json"))).resolves.toBe(false);
    expect(await fakePnpm.readCalls()).toEqual([
      {
        args: ["--dir", canonicalProjectDir, ...PNPM_INIT_INSTALL_ARGUMENTS],
        cwd: canonicalProjectDir,
      },
    ]);
    const output = stripAnsi(result.stdout);
    expect(output).toContain(`Created an eve agent in ${canonicalProjectDir} in `);
    expect(output).toContain("Creating agent...");
    expect(output).toContain("Installing dependencies...");
    expect(output).toContain("Initializing Git...");
    expect(output).not.toContain("Progress: resolved");
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

  it("warns and continues when a coding agent passes the compatibility yes flag", async () => {
    const scratch = await createScratchDirectory("eve-init-agent-fumble-");
    const fakePnpmRoot = await createScratchDirectory("eve-init-agent-fumble-pnpm-");
    const fakePnpm = await createFakePnpmEnvironment(fakePnpmRoot);

    const result = await runEveBin(scratch, ["init", "fumble-agent", "--yes"], {
      ...fakePnpm.env,
      AI_AGENT: "claude",
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("warning: --yes has no effect for eve init.");
    expect(result.stdout).toContain("eve dev --no-ui");
    await expect(pathExists(join(scratch, "fumble-agent", "agent/agent.ts"))).resolves.toBe(true);
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
