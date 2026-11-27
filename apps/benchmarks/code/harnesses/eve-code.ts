import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { HarnessBundle } from "../types.ts";
import { exists } from "./node-runtime.ts";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const BENCHMARKS_DIR = resolve(here, "../..");
const REPO_ROOT = resolve(BENCHMARKS_DIR, "../..");
const EVE_CODE_APP_DIR = resolve(here, "../eve-code-app");
const EVE_CODE_DIR = join(REPO_ROOT, "packages/eve-code");
const EVE_DIR = join(REPO_ROOT, "packages/eve");

const SKIP_DIRS = new Set([".generated", ".output", "node_modules"]);

async function gitShortSha(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd });
    return stdout.trim() || "dev";
  } catch {
    return "dev";
  }
}

async function listAppFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listAppFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function computeBuildKey(version: string, model: string, reasoning: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ version, model, reasoning }));
  for (const file of await listAppFiles(EVE_CODE_APP_DIR)) {
    hash.update(relative(EVE_CODE_APP_DIR, file));
    hash.update(await readFile(file));
  }
  hash.update(await readFile(join(here, "eve-runner.mjs")));
  hash.update(await readFile(join(EVE_CODE_DIR, "extension/instructions.md")));
  hash.update(String((await stat(join(EVE_DIR, "dist/src/index.js"))).mtimeMs));
  return hash.digest("hex").slice(0, 16);
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
  const eveBin = join(BENCHMARKS_DIR, "node_modules/.bin/eve");
  if (!(await exists(join(EVE_DIR, "dist/src/index.js")))) {
    throw new Error(
      "packages/eve/dist is missing; run `pnpm build:eve` before benchmarking eve-code.",
    );
  }
  if (!(await exists(eveBin))) {
    throw new Error(`Missing eve binary at ${eveBin}; run \`pnpm install\` first.`);
  }

  const version = await gitShortSha(REPO_ROOT);
  const key = await computeBuildKey(version, options.model, options.reasoning);
  const dest = join(options.cacheDir, "eve-code", key);
  const readyMarker = join(dest, ".ready");

  if (!(await exists(readyMarker))) {
    const scratch = await mkdtemp(join(tmpdir(), "eve-code-bench-"));
    const staging = `${dest}.staging-${Date.now()}`;
    try {
      await cp(EVE_CODE_APP_DIR, scratch, {
        recursive: true,
        filter: (src) => !SKIP_DIRS.has(src.split("/").pop() ?? ""),
      });
      await symlink(join(BENCHMARKS_DIR, "node_modules"), join(scratch, "node_modules"), "dir");

      await exec(eveBin, ["build"], {
        cwd: scratch,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          CI: "true",
          EVE_CODE_BENCH_MODEL: options.model,
          EVE_CODE_BENCH_REASONING: options.reasoning,
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
