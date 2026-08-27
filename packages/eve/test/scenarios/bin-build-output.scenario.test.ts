import { spawn } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const EVE_BIN_PATH = fileURLToPath(new URL("../../bin/eve.js", import.meta.url));
const createScratchDirectory = useTemporaryDirectories();

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }

      return segment.replace(/^[0-9;]*m/, "");
    })
    .join("");
}

function removeRolldownPluginTimingWarningBlock(stderr: string): string {
  const lines = stripAnsi(stderr).split(/\r?\n/);
  const retainedLines: string[] = [];
  let inWarningBlock = false;

  for (const line of lines) {
    // The diagnostic is timing-dependent (it fires when plugins consume
    // a large share of build time, e.g. on slow CI runners) and its
    // first line varies between rolldown versions ("[PLUGIN_TIMINGS]
    // Warning: ..." vs "[PLUGIN_TIMINGS] Your build spent ..."), so the
    // trigger matches only the stable code prefix.
    if (!inWarningBlock && line.includes("[PLUGIN_TIMINGS]")) {
      inWarningBlock = true;
      continue;
    }

    if (inWarningBlock) {
      if (line.includes("https://rolldown.rs/options/checks#plugintimings")) {
        inWarningBlock = false;
      }
      continue;
    }

    retainedLines.push(line);
  }

  return retainedLines.join("\n").trim();
}

async function createTemporaryAppRoot(input: {
  /**
   * When `true`, omit the authored `instructions.md` so discovery fails with
   * `DISCOVER_REQUIRED_INSTRUCTIONS_MISSING`. Used to exercise build failure
   * diagnostics output.
   */
  omitInstructionsSource?: boolean;
  prefix: string;
}): Promise<string> {
  const appRoot = await createScratchDirectory(input.prefix);

  await mkdir(join(appRoot, "agent"), {
    recursive: true,
  });
  await writeFile(
    join(appRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "eve-bin-build-output-test",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(appRoot, "agent", "agent.mjs"),
    'export default { model: "openai/gpt-5.4" };\n',
  );

  if (!input.omitInstructionsSource) {
    await writeFile(join(appRoot, "agent", "instructions.md"), "You are a precise assistant.\n");
  }

  return appRoot;
}

async function runEveBuild(appRoot: string): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EVE_BIN_PATH, "build"], {
      cwd: appRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out waiting for eve build output.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, 60_000);

    const settleResolve = (result: ProcessResult) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const settleReject = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", settleReject);
    child.once("exit", (code, signal) => {
      settleResolve({
        code,
        signal,
        stderr,
        stdout,
      });
    });
  });
}

describe("eve build process output", () => {
  it("prints successful build output to stdout", async () => {
    const appRoot = await createTemporaryAppRoot({
      prefix: "eve-bin-build-output-success-",
    });
    const result = await runEveBuild(appRoot);

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(removeRolldownPluginTimingWarningBlock(result.stderr)).toBe("");
    expect(result.stdout).toContain("[BUILD] built output at");
    expect(result.stdout).toContain(".output");
  }, 120_000);

  it("prints discovery diagnostics to stderr when build fails", async () => {
    const appRoot = await createTemporaryAppRoot({
      omitInstructionsSource: true,
      prefix: "eve-bin-build-output-failure-",
    });
    const resolvedAppRoot = await realpath(appRoot);
    const result = await runEveBuild(appRoot);

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Discovery failed with 1 error(s) and 0 warning(s).");
    expect(result.stderr).not.toContain("Diagnostics artifact:");
    expect(result.stderr).not.toContain(`${join(resolvedAppRoot, ".eve", "builds")}/`);
    expect(result.stderr).toContain("Discovery diagnostics:");
    expect(result.stderr).toContain(
      'Expected authored instructions at "instructions.md", "instructions.ts", "instructions.cts", "instructions.mts", "instructions.js", "instructions.cjs", "instructions.mjs", or "instructions/" directory.',
    );
    expect(result.stderr).toContain(`source: ${join(resolvedAppRoot, "agent")}`);
  }, 120_000);

  it("prints bundled missing-import errors to stderr when build fails", async () => {
    const appRoot = await createTemporaryAppRoot({
      prefix: "eve-bin-build-output-missing-import-",
    });

    await mkdir(join(appRoot, "agent", "tools"), {
      recursive: true,
    });
    await writeFile(
      join(appRoot, "agent", "tools", "bad.ts"),
      [
        'import { missing } from "./does-not-exist";',
        "export default {",
        '  description: "Missing import test.",',
        '  inputSchema: { type: "object", properties: {}, required: [] },',
        "  execute: async () => String(missing),",
        "};",
        "",
      ].join("\n"),
    );

    const result = await runEveBuild(appRoot);

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not resolve './does-not-exist'");
    expect(result.stderr).toContain("Build failed with 1 error:");
    expect(result.stderr).toContain("agent/tools/bad.ts");
    expect(result.stderr).not.toContain("Diagnostics artifact:");
  }, 120_000);

  it("prints bundled syntax errors to stderr when build fails", async () => {
    const appRoot = await createTemporaryAppRoot({
      prefix: "eve-bin-build-output-syntax-error-",
    });

    await mkdir(join(appRoot, "agent", "tools"), {
      recursive: true,
    });
    await writeFile(
      join(appRoot, "agent", "tools", "bad.ts"),
      [
        "export default {",
        '  description: "Syntax error test.",',
        '  inputSchema: { type: "object", properties: {}, required: [] },',
        '  execute: async () => "broken",',
        "",
      ].join("\n"),
    );

    const result = await runEveBuild(appRoot);

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unexpected token");
    expect(result.stderr).toContain("Build failed with 1 error:");
    expect(result.stderr).toContain("agent/tools/bad.ts");
    expect(result.stderr).not.toContain("Diagnostics artifact:");
  }, 120_000);

  it("prints authored-definition shape errors to stderr when build fails", async () => {
    const appRoot = await createTemporaryAppRoot({
      prefix: "eve-bin-build-output-definition-shape-",
    });

    await mkdir(join(appRoot, "agent", "tools"), {
      recursive: true,
    });
    await writeFile(join(appRoot, "agent", "tools", "bad.ts"), 'export default "not-an-object";\n');

    const result = await runEveBuild(appRoot);

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'Expected the tool export "default" from "tools/bad.ts" to match the public eve shape.',
    );
    expect(result.stderr).not.toContain("Diagnostics artifact:");
  }, 120_000);
});
