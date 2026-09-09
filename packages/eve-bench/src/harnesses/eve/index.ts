import { execFile } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  Harness,
  HarnessBundle,
  HarnessPrepareContext,
  HarnessRunContext,
} from "../../core/harness.ts";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../../..");
const repoRoot = resolve(packageRoot, "../..");
const NODE_VERSION = "24.19.0";
const ARCHES = ["x64", "arm64"] as const;

export type EveSource =
  | { readonly kind: "local" }
  | { readonly kind: "release"; readonly version: string };

/**
 * Builds the `agent/` app against a local or released eve, and packages the
 * Nitro output and runner with architecture-specific Linux Node binaries.
 * Cached by content hash.
 */
export function createEveHarness(source: EveSource): Harness {
  return {
    name: source.kind === "local" ? "eve@local" : `eve@${source.version}`,
    prepare: (ctx) => prepare(source, ctx),
    command: (ctx) => `sh ${ctx.installDir}/run.sh`,
    env: (ctx: HarnessRunContext) => ({
      EVE_PROJECT_DIR: `${ctx.installDir}/app`,
      EVE_INSTRUCTION_PATH: ctx.instructionPath,
      EVE_AGENT_LOGS_DIR: ctx.logsDir,
      EVE_BENCH_MODEL: ctx.model,
      EVE_BENCH_TASK_WORKDIR: ctx.taskWorkdir,
    }),
  };
}

async function prepare(source: EveSource, ctx: HarnessPrepareContext): Promise<HarnessBundle> {
  const eve: ResolvedEve =
    source.kind === "local"
      ? await resolveLocalEve()
      : {
          dependency: source.version,
          identity: source.version,
          provenance: { kind: "release", version: source.version },
        };

  const hash = createHash("sha256");
  hash.update(eve.identity).update(ctx.model).update(NODE_VERSION);
  for (const file of await listFiles(join(packageRoot, "agent")))
    hash.update(file).update(await readFile(join(packageRoot, "agent", file)));
  hash.update(await readFile(join(here, "runner.mjs"))).update(RUN_SH);
  const key = hash.digest("hex").slice(0, 16);
  const bundleDir = join(ctx.cacheDir, "bundles", key);
  const provenance = { key, model: ctx.model, eve: eve.provenance };
  const nodeDir = join(ctx.cacheDir, `node-v${NODE_VERSION}`);
  await Promise.all(ARCHES.map((arch) => ensureNode(nodeDir, arch)));
  const arch = Object.fromEntries(ARCHES.map((name) => [name, join(nodeDir, name)])) as Record<
    (typeof ARCHES)[number],
    string
  >;
  if (await exists(join(bundleDir, "run.sh"))) return { dir: bundleDir, arch, provenance };

  const building = `${bundleDir}.building`;
  await rm(building, { recursive: true, force: true });
  const app = join(building, "app");
  await mkdir(app, { recursive: true });
  await cp(join(packageRoot, "agent"), join(app, "agent"), { recursive: true });
  await writeFile(
    join(app, "package.json"),
    `${JSON.stringify({ name: "eve-bench-app", private: true, type: "module", dependencies: { eve: eve.dependency, zod: "4.4.3" } }, null, 2)}\n`,
  );
  await writeFile(join(app, "tsconfig.json"), APP_TSCONFIG);
  await writeFile(join(app, ".npmrc"), "registry=https://registry.npmjs.org/\n");
  if (source.kind === "local") {
    const artifacts = join(ctx.cacheDir, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await cp(await packLocalEve(artifacts), join(app, "eve.tgz"));
  }
  const npm = (...args: string[]) =>
    execFileAsync("npm", [...args, "--ignore-scripts", "--userconfig", join(app, ".npmrc")], {
      cwd: app,
      maxBuffer: 64 * 1024 * 1024,
    });
  await npm("install", "--package-lock-only");
  await npm("ci");
  await execFileAsync(join(app, "node_modules", ".bin", "eve"), ["build"], {
    cwd: app,
    env: { ...process.env, EVE_BENCH_MODEL: ctx.model, EVE_BENCH_TASK_WORKDIR: "/workspace" },
    maxBuffer: 64 * 1024 * 1024,
  });
  await rm(join(app, "agent"), { recursive: true, force: true });
  await rm(join(app, "package-lock.json"), { force: true });
  await rm(join(app, ".npmrc"), { force: true });
  await rm(join(app, "eve.tgz"), { force: true });
  await rm(join(app, "tsconfig.json"), { force: true });
  await rm(join(app, ".eve"), { recursive: true, force: true });
  // Nitro's `.output` is self-contained and the runner speaks plain HTTP.
  await rm(join(app, "node_modules"), { recursive: true, force: true });
  await cp(join(here, "runner.mjs"), join(app, "runner.mjs"));
  await writeFile(join(building, "run.sh"), RUN_SH, { mode: 0o755 });
  await writeFile(join(building, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  await rm(bundleDir, { recursive: true, force: true });
  await rename(building, bundleDir);
  return { dir: bundleDir, arch, provenance };
}

interface ResolvedEve {
  readonly dependency: string;
  readonly identity: string;
  readonly provenance: Record<string, unknown>;
}

async function resolveLocalEve(): Promise<ResolvedEve> {
  const evePackage = join(repoRoot, "packages/eve");
  const dist = join(evePackage, "dist");
  if (!(await isDirectory(dist))) {
    throw new Error(
      "Local eve dist is missing. Run `pnpm build` or `pnpm --filter eve build` first.",
    );
  }

  const hash = createHash("sha256");
  hash.update("package.json\0").update(await readFile(join(evePackage, "package.json")));
  for (const file of await listFiles(dist)) {
    hash.update("\0").update(file).update("\0");
    await hashFile(hash, join(dist, file));
  }
  const distSha256 = hash.digest("hex");
  const [gitSha, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    execFileAsync("git", ["status", "--porcelain", "packages/eve"], { cwd: repoRoot }),
  ]);
  return {
    dependency: "file:eve.tgz",
    identity: distSha256,
    provenance: {
      kind: "local",
      gitSha: gitSha.stdout.trim(),
      dirty: status.stdout.trim().length > 0,
      distSha256,
    },
  };
}

async function packLocalEve(artifacts: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["--filter", "eve", "pack", "--pack-destination", artifacts, "--json"],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const jsonStart = stdout.indexOf("{");
  const packed = JSON.parse(stdout.slice(jsonStart)) as { filename: string };
  return resolve(artifacts, packed.filename);
}

async function ensureNode(nodeDir: string, arch: (typeof ARCHES)[number]): Promise<void> {
  const archDir = join(nodeDir, arch);
  const target = join(archDir, "node");
  if (await exists(target)) return;
  await mkdir(archDir, { recursive: true });
  const name = `node-v${NODE_VERSION}-linux-${arch}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.xz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  const archive = join(nodeDir, `${name}.tar.xz`);
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  const extractDir = join(nodeDir, `${name}.extract`);
  await mkdir(extractDir, { recursive: true });
  await execFileAsync("tar", [
    "-xJf",
    archive,
    "--strip-components=2",
    "-C",
    extractDir,
    `${name}/bin/node`,
  ]);
  await rename(join(extractDir, "node"), target);
  await chmod(target, 0o755);
  await rm(extractDir, { recursive: true, force: true });
  await rm(archive, { force: true });
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), rel)));
    else files.push(rel);
  }
  return files;
}

async function hashFile(hash: Hash, path: string): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const RUN_SH = `#!/bin/sh
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
exec "$dir/arch/node" "$dir/app/runner.mjs"
`;

const APP_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2024",
      lib: ["ES2024"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      moduleDetection: "force",
      verbatimModuleSyntax: true,
      noEmit: true,
      strict: true,
      isolatedModules: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["agent/**/*.ts"],
  },
  null,
  2,
)}\n`;
