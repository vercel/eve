import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { HarnessBundle } from "../types.ts";
import { exists } from "./node-runtime.ts";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");
const EVE_CODE_DIR = join(REPO_ROOT, "packages/eve-code");
const EVE_DIR = join(REPO_ROOT, "packages/eve");

function renderEveCodeAppFiles(reasoning: string): Record<string, string> {
  return {
    "agent/agent.ts": [
      'import { defineAgent } from "eve";',
      "const model = process.env.EVE_CODE_BENCH_MODEL;",
      'if (!model) throw new Error("EVE_CODE_BENCH_MODEL must be set");',
      `export default defineAgent({ model, reasoning: ${JSON.stringify(reasoning)} });`,
      "",
    ].join("\n"),
    "agent/instructions.md": "The task's working directory is /workspace.\n",
    "agent/extensions/code.ts": [
      'import code from "eve/extensions/code";',
      "export default code({});",
      "",
    ].join("\n"),
    "agent/channels/eve.ts": [
      'import { eveChannel } from "eve/channels/eve";',
      'import { verifyHttpBasic, withAuthChallenges } from "eve/channels/auth";',
      "",
      "const benchAuth = withAuthChallenges(",
      "  (request) => {",
      "    const password = process.env.EVE_BENCH_TOKEN;",
      "    if (!password) return null;",
      '    const result = verifyHttpBasic(request.headers.get("authorization"), {',
      '      username: "code-bench",',
      "      password,",
      "    });",
      "    return result.ok ? result.sessionAuth : null;",
      "  },",
      '  [{ scheme: "Basic", parameters: { realm: "code-bench", charset: "UTF-8" } }],',
      ");",
      "",
      "export default eveChannel({ auth: [benchAuth] });",
      "",
    ].join("\n"),
    "agent/sandbox.ts": [
      'import { defineSandbox } from "eve/sandbox";',
      'import { defineSandboxProvider, SandboxSessionGoneError } from "eve/sandbox/provider";',
      'import { TASK_CONTAINER_PROVIDER_NAME, taskContainerEnvironment } from "./lib/container-sandbox.mjs";',
      "",
      "const TaskContainerSandbox = defineSandboxProvider({",
      "  name: TASK_CONTAINER_PROVIDER_NAME,",
      "  stateProtocolVersion: 1,",
      "  environment(options) {",
      "    const implementation = taskContainerEnvironment(options);",
      "    return {",
      "      ...implementation,",
      "      async resume(...args) {",
      "        try {",
      "          return await implementation.resume(...args);",
      "        } catch (error) {",
      '          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {',
      '            throw new SandboxSessionGoneError("The benchmark task container no longer exists");',
      "          }",
      "          throw error;",
      "        }",
      "      },",
      "    };",
      "  },",
      "});",
      "",
      "export const environment = TaskContainerSandbox.environment();",
      "export default defineSandbox(() => environment.open());",
      "",
    ].join("\n"),
    "agent/tools/web_search.ts":
      'import { disableTool } from "eve/tools";\nexport default disableTool();\n',
    "agent/tools/web_fetch.ts":
      'import { disableTool } from "eve/tools";\nexport default disableTool();\n',
  };
}

async function gitShortSha(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd });
    return stdout.trim() || "dev";
  } catch {
    return "dev";
  }
}

async function bundleRunnerWithClient(outFile: string): Promise<void> {
  const rolldownPath = join(EVE_DIR, "node_modules/rolldown/dist/index.mjs");
  const { rolldown } = (await import(rolldownPath)) as {
    rolldown: (options: Record<string, unknown>) => Promise<{
      write: (options: Record<string, unknown>) => Promise<unknown>;
      close?: () => Promise<void>;
    }>;
  };
  const bundle = await rolldown({
    input: join(here, "eve-runner.mjs"),
    platform: "node",
    resolve: {
      alias: {
        "eve/client": join(EVE_DIR, "dist/src/client/index.js"),
      },
    },
    external: [/^node:/],
  });
  try {
    await bundle.write({
      file: outFile,
      format: "esm",
      codeSplitting: false,
    });
  } finally {
    await bundle.close?.();
  }
}

export async function prepareEveCodeHarness(options: {
  readonly cacheDir: string;
  readonly model: string;
  readonly reasoning: string;
}): Promise<HarnessBundle> {
  const eveBin = join(EVE_CODE_DIR, "node_modules/.bin/eve");
  if (!(await exists(join(EVE_DIR, "dist/src/index.js")))) {
    throw new Error(
      "packages/eve/dist is missing; run `pnpm build:eve` before benchmarking eve-code.",
    );
  }
  if (!(await exists(eveBin))) {
    throw new Error(`Missing eve binary at ${eveBin}; run \`pnpm install\` first.`);
  }

  const version = await gitShortSha(REPO_ROOT);
  const files = renderEveCodeAppFiles(options.reasoning);
  const [containerSandboxSource, runnerSource, extInstructions] = await Promise.all([
    readFile(join(here, "container-sandbox.mjs"), "utf8"),
    readFile(join(here, "eve-runner.mjs"), "utf8"),
    readFile(join(EVE_CODE_DIR, "extension/instructions.md"), "utf8"),
  ]);

  const eveDistMtime = (await stat(join(EVE_DIR, "dist/src/index.js"))).mtimeMs;
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version,
        model: options.model,
        reasoning: options.reasoning,
        files,
        containerSandboxSource,
        runnerSource,
        extInstructions,
        eveDistMtime,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  const dest = join(options.cacheDir, "eve-code", key);
  const readyMarker = join(dest, ".ready");

  if (!(await exists(readyMarker))) {
    const scratch = await mkdtemp(join(await realpath(EVE_CODE_DIR), ".code-bench-"));
    const staging = `${dest}.staging-${Date.now()}`;
    try {
      await writeFile(
        join(scratch, "package.json"),
        `${JSON.stringify(
          {
            name: "eve-code-bench-app",
            private: true,
            type: "module",
            dependencies: { eve: "workspace:*" },
          },
          null,
          2,
        )}\n`,
      );
      await cp(join(EVE_CODE_DIR, "tsconfig.json"), join(scratch, "tsconfig.json"));
      for (const [rel, content] of Object.entries(files)) {
        const target = join(scratch, rel);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      await mkdir(join(scratch, "agent/lib"), { recursive: true });
      await writeFile(join(scratch, "agent/lib/container-sandbox.mjs"), containerSandboxSource);

      await exec(eveBin, ["build"], {
        cwd: scratch,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          CI: "true",
          EVE_CODE_BENCH_MODEL: options.model,
        },
        maxBuffer: 16 * 1024 * 1024,
      });

      await mkdir(join(staging, "app"), { recursive: true });
      await cp(join(scratch, ".output"), join(staging, "app/.output"), {
        recursive: true,
        dereference: true,
      });
      await bundleRunnerWithClient(join(staging, "runner.mjs"));
      await writeFile(join(staging, ".ready"), `${key}\n`);
      await mkdir(dirname(dest), { recursive: true });
      await rename(staging, dest).catch(async (error: unknown) => {
        if (!(await exists(readyMarker))) throw error;
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  return {
    harness: "eve-code",
    version,
    dir: dest,
  };
}
