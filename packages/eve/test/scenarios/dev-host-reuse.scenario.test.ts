import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();

/** Starts headless `eve dev`, reads its agent info, and stops it with SIGINT. */
async function runDevelopmentServer(
  appRoot: string,
): Promise<{ readonly agentName: string; readonly instructions: string }> {
  const child = spawn(
    process.execPath,
    [join(appRoot, "node_modules", "eve", "bin", "eve.js"), "dev", "--no-ui", "--port", "0"],
    { cwd: appRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`eve dev did not start:\n${output}`)),
        90_000,
      );
      child.stdout.on("data", () => {
        const match = /server listening at (http:\/\/\S+)/u.exec(output);
        if (match !== null) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      void exited.then(() => reject(new Error(`eve dev exited:\n${output}`)));
    });
    const info = (await (await fetch(new URL("/eve/v1/info", url))).json()) as {
      readonly agent: { readonly name: string };
      readonly instructions: { readonly static: readonly { readonly content: string }[] };
    };
    return {
      agentName: info.agent.name,
      instructions: info.instructions.static.map((source) => source.content).join("\n"),
    };
  } finally {
    child.kill("SIGINT");
    await exited;
  }
}

async function keptWorkspace(appRoot: string): Promise<string> {
  const record = JSON.parse(
    await readFile(join(appRoot, ".eve", "dev-hosts", "reusable-host.json"), "utf8"),
  ) as { readonly workspace: { readonly rootDir: string } };
  return record.workspace.rootDir;
}

// A packed install, where eve lives under node_modules and may reuse a host.
describe("eve dev host reuse", () => {
  it("serves authored edits from the kept host and rebuilds it when the host changes", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.mjs":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
        "agent/instructions.md": "You are a precise assistant.\n",
      },
      installDependencies: true,
      name: "dev-host-reuse",
    });
    const hosts = async () =>
      (await readdir(join(app.appRoot, ".eve", "dev-hosts"))).filter(
        (name) => name !== "reusable-host.json",
      );

    expect(await runDevelopmentServer(app.appRoot)).toMatchObject({ agentName: "dev-host-reuse" });
    const firstHost = await keptWorkspace(app.appRoot);

    // Instructions are generation content: the kept host serves the edit.
    await writeFile(join(app.appRoot, "agent", "instructions.md"), "You answer in haiku.\n");
    expect((await runDevelopmentServer(app.appRoot)).instructions).toContain("haiku");
    expect(await keptWorkspace(app.appRoot)).toBe(firstHost);

    // Env files shape the host, so the next start builds a new one.
    await writeFile(join(app.appRoot, ".env.local"), "REUSE_SCENARIO=1\n");
    await runDevelopmentServer(app.appRoot);
    const rebuiltHost = await keptWorkspace(app.appRoot);
    expect(rebuiltHost).not.toBe(firstHost);
    expect(await hosts()).toEqual([basename(rebuiltHost)]);
  }, 300_000);
});
