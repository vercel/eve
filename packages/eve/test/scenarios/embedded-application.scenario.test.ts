import { execFile } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePnpmInvocation } from "#internal/process/pnpm.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const fixtureRoot = join(repositoryRoot, "apps/fixtures/embedded-triage-cli");
const outputDirectory = join(fixtureRoot, ".output");
const generatedDirectory = join(fixtureRoot, ".eve");

async function runFixture(...args: string[]) {
  const invocation = resolvePnpmInvocation([
    "--filter",
    "embedded-triage-cli",
    "embedded-triage",
    ...args,
  ]);
  return await execFileAsync(invocation.command, [...invocation.args], {
    cwd: repositoryRoot,
    env: { ...process.env, EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
    maxBuffer: 20 * 1024 * 1024,
    shell: invocation.shell,
  });
}

describe("embedded triage application", () => {
  beforeAll(async () => {
    await Promise.all(
      [generatedDirectory, outputDirectory].map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });
  afterAll(async () => {
    await Promise.all(
      [generatedDirectory, outputDirectory].map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("runs a real local task and builds the production workflow application", async () => {
    await expect(access(join(fixtureRoot, "agent"))).rejects.toMatchObject({ code: "ENOENT" });

    const run = await runFixture("run", "./sample-ticket.json");
    expect(JSON.parse(run.stdout)).toEqual({
      category: "authentication",
      priority: "high",
      summary: "Customer cannot sign in after resetting their password.",
    });
    expect(run.stderr).toContain("Triaging support ticket...");
    expect(run.stderr).toContain("Support ticket triage complete.");

    const build = await runFixture("build");
    expect(build.stdout.trim()).toBe(outputDirectory);
    const serverSource = await readFile(join(outputDirectory, "server/index.mjs"), "utf8");
    expect(serverSource).toContain('route: "/.well-known/workflow/v1/flow"');
    expect(serverSource).toContain("embedded:config:embedded-agent.mjs");
    expect(serverSource).toContain("compiled-artifacts-bootstrap.mjs");
    await expect(access(join(fixtureRoot, "agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
