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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Harness, HarnessBundle, HarnessPrepareContext } from "../../core/harness.ts";
import { ensureNode, NODE_VERSION } from "../eve/index.ts";
import { readEveUsage } from "../eve/usage.ts";
import { copySource, hashTree } from "./snapshot.ts";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const REASONING = ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"];

export interface E0Options {
  readonly agent: string;
  readonly reasoning?: string;
}

export function createE0Harness(options: E0Options): Harness {
  if (!options.agent?.trim())
    throw new Error(
      "--agent must point to the installed e0 application (containing agent/ and package.json)",
    );
  if (options.reasoning && !REASONING.includes(options.reasoning))
    throw new Error(`Unsupported e0 reasoning: ${options.reasoning}`);
  const agent = resolve(options.agent);
  return {
    name: "e0",
    credentials: ["AI_GATEWAY_API_KEY"],
    prepare: (ctx) => prepareE0({ ...options, agent }, ctx),
    command: (ctx) => `exec '${ctx.installDir}/arch/node' '${ctx.installDir}/app/runner.mjs'`,
    readUsage: readEveUsage,
    env: (ctx) => {
      const env: Record<string, string> = {
        EVE_PROJECT_DIR: `${ctx.installDir}/app`,
        EVE_INSTRUCTION_PATH: ctx.instructionPath,
        EVE_AGENT_LOGS_DIR: ctx.logsDir,
        EVE_BENCH_CONTAINER: "1",
        EVE_BENCH_TASK_WORKDIR: ctx.taskWorkdir,
        E0_MODEL: ctx.model,
      };
      if (options.reasoning) env.E0_REASONING = options.reasoning;
      return env;
    },
  };
}

export async function adaptE0(app: string): Promise<void> {
  const agent = join(app, "agent");
  // These integrations are outside the self-contained terminal workload. Authored
  // coding behavior remains intact, including the extension's worker model.
  for (const slot of ["sandbox", "channels", "schedules", "connections", "instrumentation"]) {
    await rm(join(agent, slot), { recursive: true, force: true });
    await rm(join(agent, `${slot}.ts`), { force: true });
  }
  await mkdir(join(agent, "lib"), { recursive: true });
  await cp(join(here, "container-backend.ts"), join(agent, "lib/eve-bench-backend.ts"));
  await writeFile(
    join(agent, "sandbox.ts"),
    `import { defineSandbox } from "eve/sandbox";\nimport { containerBackend } from "./lib/eve-bench-backend.ts";\nexport default defineSandbox({ backend: () => containerBackend() });\n`,
  );
  await mkdir(join(agent, "channels"), { recursive: true });
  await writeFile(
    join(agent, "channels/eve.ts"),
    `import { eveChannel } from "eve/channels/eve";\nimport { localDev } from "eve/channels/auth";\nexport default eveChannel({ auth: [localDev()] });\n`,
  );
  await writeFile(
    join(agent, "extensions/code.ts"),
    `import code from "eve-code";\nexport default code({});\n`,
  );
}

async function sourceIdentity(agent: string, extension: string) {
  const pkg = JSON.parse(await readFile(join(agent, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const dependencies: Record<string, string> = {};
  for (const name of Object.keys(pkg.dependencies).sort()) {
    const installed = JSON.parse(
      await readFile(join(agent, "node_modules", name, "package.json"), "utf8"),
    ) as { version: string };
    dependencies[name] = installed.version;
  }
  const gitRoot = (
    await exec("git", ["rev-parse", "--show-toplevel"], { cwd: agent })
  ).stdout.trim();
  const gitSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: agent })).stdout.trim();
  const scope = [
    relative(gitRoot, agent),
    relative(gitRoot, extension),
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ];
  const conflicts = (
    await exec("git", ["diff", "--name-only", "--diff-filter=U", "--", ...scope], { cwd: gitRoot })
  ).stdout.trim();
  if (conflicts) throw new Error(`e0 source has unresolved merge conflicts:\n${conflicts}`);
  const status = (
    await exec("git", ["status", "--porcelain", "--", ...scope], { cwd: gitRoot })
  ).stdout
    .split("\n")
    .filter((line) => !line.includes("/.eve-bench-"))
    .join("\n");
  const metadata = createHash("sha256");
  for (const file of [
    join(agent, "package.json"),
    join(agent, "tsconfig.json"),
    join(extension, "package.json"),
    join(extension, "tsconfig.json"),
    join(gitRoot, "pnpm-lock.yaml"),
    join(gitRoot, "pnpm-workspace.yaml"),
  ]) {
    metadata
      .update(relative(gitRoot, file))
      .update("\0")
      .update(await readFile(file));
  }
  return {
    gitSha,
    dirty: status.trim().length > 0,
    agentSha256: await hashTree(join(agent, "agent")),
    extensionSha256: await hashTree(join(extension, "extension")),
    metadataSha256: metadata.digest("hex"),
    eveDistSha256: await hashTree(join(agent, "node_modules/eve/dist")),
    dependencies,
  };
}

async function prepareE0(options: E0Options, ctx: HarnessPrepareContext): Promise<HarnessBundle> {
  const agent = await realpath(options.agent);
  let extension: string;
  try {
    extension = await realpath(join(agent, "node_modules/eve-code"));
    await stat(join(extension, "extension/extension.ts"));
    await stat(join(agent, "node_modules/.bin/eve"));
    await stat(join(agent, "agent/extensions/code.ts"));
  } catch {
    throw new Error(
      "e0 requires installed workspace dependencies and source-backed eve-code. Run pnpm install in internal-agents first.",
    );
  }
  const source = await sourceIdentity(agent, extension);
  const adapter = createHash("sha256");
  for (const file of [
    "index.ts",
    "snapshot.ts",
    "container-backend.ts",
    "../eve/index.ts",
    "../eve/runner.mjs",
  ])
    adapter.update(await readFile(join(here, file)));
  const identity = {
    source,
    model: ctx.model,
    reasoning: options.reasoning ?? "authored",
    workerModel: "authored (not overridden)",
    nodeVersion: NODE_VERSION,
    adapterSha256: adapter.digest("hex"),
    adaptation:
      "Task-container sandbox; local eve channel; production extension configuration removed. No production channels, schedules, connections, instrumentation, sandbox bootstrap, or Connect configuration. Instructions, coding capabilities, tools, skills, and authored worker preserved.",
  };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const cache = resolve(ctx.cacheDir);
  const destination = join(cache, "e0", key);
  const nodeDir = join(cache, `node-v${NODE_VERSION}`);
  await Promise.all((["x64", "arm64"] as const).map((arch) => ensureNode(nodeDir, arch)));
  const bundle = {
    dir: destination,
    arch: { x64: join(nodeDir, "x64"), arm64: join(nodeDir, "arm64") },
    provenance: { key, ...identity },
  };
  if (await exists(join(destination, "provenance.json"))) return bundle;

  // An adjacent disposable directory resolves the already-installed dependency
  // graph without modifying source files, installing new versions, or adding links.
  const scratch = await mkdtemp(join(agent, ".eve-bench-"));
  const buildEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CI: "true",
    E0_MODEL: ctx.model,
  };
  if (options.reasoning) buildEnv.E0_REASONING = options.reasoning;
  try {
    await copySource(join(agent, "agent"), join(scratch, "agent"));
    for (const file of ["package.json", "tsconfig.json"])
      await cp(join(agent, file), join(scratch, file));
    const stagedExtension = join(scratch, "node_modules/eve-code");
    await mkdir(stagedExtension, { recursive: true });
    await copySource(join(extension, "extension"), join(stagedExtension, "extension"));
    for (const file of ["package.json", "tsconfig.json"])
      await cp(join(extension, file), join(stagedExtension, file));
    const eve = join(agent, "node_modules/.bin/eve");
    await exec(eve, ["extension", "build"], {
      cwd: stagedExtension,
      env: buildEnv,
      maxBuffer: 8 * 1024 * 1024,
    });
    await adaptE0(scratch);
    await exec(eve, ["build"], { cwd: scratch, env: buildEnv, maxBuffer: 16 * 1024 * 1024 });
    const after = await sourceIdentity(agent, extension);
    if (JSON.stringify(after) !== JSON.stringify(source)) {
      throw new Error(
        "e0 source or dependencies changed during preparation; retry after edits settle",
      );
    }
    await mkdir(join(cache, "e0"), { recursive: true });
    const publishing = await mkdtemp(join(cache, "e0/.publish-"));
    try {
      await mkdir(join(publishing, "app"));
      await cp(join(scratch, ".output"), join(publishing, "app/.output"), {
        recursive: true,
        dereference: true,
      });
      await cp(join(here, "../eve/runner.mjs"), join(publishing, "app/runner.mjs"));
      await writeFile(
        join(publishing, "provenance.json"),
        `${JSON.stringify(bundle.provenance, null, 2)}\n`,
      );
      try {
        await rename(publishing, destination);
      } catch (error) {
        if (!(await exists(join(destination, "provenance.json")))) throw error;
      }
    } finally {
      await rm(publishing, { recursive: true, force: true });
    }
    return bundle;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
