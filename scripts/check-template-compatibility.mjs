#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const templatesDirectory = join(repoRoot, "apps", "templates");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "eve-template-compatibility-"));

// Each template runs in its own copy under `temporaryDirectory` with its own
// lockfile-resolved `node_modules`, so the checks share no mutable state: the
// eve tarball is packed once up front and only read afterwards, and the one
// template that boots a server (`personal-agent-template`'s smoke test) is the
// only one that binds a port. That makes it safe to run several templates at
// once, bounded so an install/build-heavy template cannot starve the others on
// a 4-vCPU runner.
const MAX_CONCURRENT_TEMPLATES = 3;

// Templates ordered by their measured wall time in CI, longest first, so the
// expensive `next build`/`nuxt build` templates start on the first worker slots
// instead of queueing behind cheap ones. Durations come from the per-command
// timestamps in a serial CI run; a template missing from this list runs
// alphabetically afterwards.
const TEMPLATES_BY_EXPECTED_DURATION = [
  "personal-agent-template", // 73s, mostly `nuxt build`
  "eve-chat-template", // 49s, mostly `next build`
  "eve-voice-template", // 31s, mostly `next build`
  "eve-llm-council-template", // 14s
  "slack-company-brain-template", // 11s, `eve build` only
  "eve-data-agent-template", // 7s, `eve build` only
  "eve-discord-agent-template", // 6s
  "eve-slack-agent-template", // 5s
  "eve-coding-agent-template", // 4s
];

const compareByExpectedDuration = (left, right) => {
  const leftIndex = TEMPLATES_BY_EXPECTED_DURATION.indexOf(left);
  const rightIndex = TEMPLATES_BY_EXPECTED_DURATION.indexOf(right);
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
  if (leftIndex === -1) return 1;
  if (rightIndex === -1) return -1;
  return leftIndex - rightIndex;
};

// Vercel Framework Preset slugs a template web service may deploy under. Vercel rejects unknown
// slugs at deploy time, and eve's own host names differ from them (Nuxt is "nuxtjs", not "nuxt").
const VERCEL_WEB_FRAMEWORKS = new Set(["nextjs", "nuxtjs", "sveltekit", "tanstack-start"]);

/**
 * Writes a child's output one line at a time, prefixed with the template it
 * belongs to, so concurrent templates stay readable in the CI log.
 */
const prefixLines = (template, stream) => {
  let pending = "";
  const emit = (line) => stream.write(`[${template}] ${line}\n`);
  return {
    write(chunk) {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        emit(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    flush() {
      if (pending.length === 0) return;
      emit(pending);
      pending = "";
    },
  };
};

const run = (template, command, args, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    process.stdout.write(`[${template}] $ ${command} ${args.join(" ")}\n`);
    // `spawn` (not `execFile`) so the child streams its output through the line
    // prefixer instead of buffering it into `execFile`'s 1 MB `maxBuffer`.
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    const stdout = prefixLines(template, process.stdout);
    const stderr = prefixLines(template, process.stderr);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      stdout.flush();
      stderr.flush();
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `[${template}] ${command} ${args.join(" ")} ${signal === null ? `exited with code ${code}` : `was killed by ${signal}`}`,
        ),
      );
    });
  });

/**
 * Deploy with Vercel clones a template from main and installs its committed lockfile, so the
 * template must typecheck with the published eve release that lockfile pins, not only with the
 * packed eve checked afterwards.
 */
const checkCommittedLockfile = async (template, destination) => {
  await run(template, "pnpm", ["install", "--frozen-lockfile"], { cwd: destination });
  await run(template, "pnpm", ["typecheck"], { cwd: destination });
};

/**
 * Builds each authored `vercel.ts` service the way Vercel does: from the service root, where a
 * root-only pnpm install puts no framework binary on PATH. The template's own `pnpm build` runs
 * from the project root and cannot catch a service that only builds there. Returns how many
 * services it built.
 */
const checkVercelServices = async (template, destination) => {
  if (!existsSync(join(destination, "vercel.ts"))) return 0;
  const services = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { default: config } = await import("./vercel.ts"); console.log(JSON.stringify(config.services ?? {}));',
      ],
      { cwd: destination, encoding: "utf8" },
    ),
  );
  const path = process.env.PATH?.split(delimiter)
    .filter((entry) => !entry.includes("node_modules"))
    .join(delimiter);

  let built = 0;
  for (const [name, service] of Object.entries(services)) {
    // withEve generates and owns the agent services.
    if (service.framework === "eve") continue;
    const label = `Template "${template}" vercel.ts service "${name}"`;
    if (!VERCEL_WEB_FRAMEWORKS.has(service.framework)) {
      throw new Error(
        `${label} uses framework ${JSON.stringify(service.framework)}, which is not a Vercel Framework Preset slug. Use one of: ${[...VERCEL_WEB_FRAMEWORKS].join(", ")}.`,
      );
    }
    const serviceRoot = join(destination, service.root ?? ".");
    if (existsSync(join(serviceRoot, "package.json")) && !service.buildCommand) continue;
    if (!service.buildCommand) {
      throw new Error(
        `${label} has no package.json in ${service.root}, so Vercel cannot find the framework binary. Set buildCommand to run it from the root node_modules.`,
      );
    }
    process.stdout.write(`[${template}] $ (cd ${service.root} && ${service.buildCommand})\n`);
    await run(template, "sh", ["-c", service.buildCommand], {
      cwd: serviceRoot,
      env: { ...process.env, PATH: path },
    });
    built++;
  }
  return built;
};

const checkTemplate = async (template, tarball, tarballName) => {
  const source = join(templatesDirectory, template);
  const destination = join(temporaryDirectory, template);
  cpSync(source, destination, {
    filter: (path) =>
      !["node_modules", ".next", ".nuxt", ".output", ".eve", ".vercel"].includes(basename(path)),
    recursive: true,
  });

  const manifestPath = join(destination, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.dependencies?.eve) {
    throw new Error(`Template "${template}" does not declare eve in dependencies`);
  }

  process.stdout.write(`\n[${template}] Checking ${template} with its committed lockfile\n`);
  await checkCommittedLockfile(template, destination);

  manifest.dependencies.eve = `file:${tarball}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // The shipped Discord template pins the old gateway API. Exercise its documented
  // 1.0 migration only in the upgraded copy, after checking the lockfile unchanged.
  if (template === "eve-discord-agent-template") {
    const daemonPath = join(destination, "daemon", "main.ts");
    const daemon = readFileSync(daemonPath, "utf8")
      .replace('"eve/channels/discord/gateway"', '"eve/experimental/channels/discord/gateway"')
      .replaceAll("experimental_runDiscordGatewayRelay", "runDiscordGatewayRelay");
    writeFileSync(daemonPath, daemon);
  }

  process.stdout.write(`\n[${template}] Checking ${template} against ${tarballName}\n`);
  await run(template, "pnpm", ["install", "--no-frozen-lockfile"], { cwd: destination });
  await run(template, "pnpm", ["typecheck"], { cwd: destination });
  // Preparing a Vercel Sandbox snapshot needs Vercel credentials, which this
  // check does not have. Such templates skip the prewarm.
  const agentDirectory = join(destination, "agent");
  const vercelSandbox = readdirSync(agentDirectory, { recursive: true }).some(
    (path) =>
      basename(path) === "sandbox.ts" &&
      readFileSync(join(agentDirectory, path), "utf8").includes("eve/sandbox/vercel"),
  );
  // Non-secret build fixtures preserve fail-fast production configuration
  // without giving this compatibility check credentials to external services.
  const buildEnv = { ...process.env };
  if (template === "kody-eve-template") {
    Object.assign(buildEnv, {
      LINEAR_CONNECTOR: "linear/template-ci",
      REDIS_URL: "redis://127.0.0.1:6379",
      RESEND_FROM_ADDRESS: "kody@example.com",
      DIGEST_REPO: "acme/widgets",
      DIGEST_EMAIL: "team@example.com",
    });
  }
  await run(
    template,
    "pnpm",
    ["exec", "eve", "build", ...(vercelSandbox ? ["--skip-sandbox-prewarm"] : [])],
    { cwd: destination, env: buildEnv },
  );
  // A template's `pnpm build` is `eve build` plus, at most, its web app, which
  // the service builds just produced the way Vercel does. Run it only when
  // neither covers it, so no template builds its agent or web app twice.
  const builtServices = await checkVercelServices(template, destination);
  const build = manifest.scripts?.build;
  if (!vercelSandbox && build && build !== "eve build" && builtServices === 0) {
    await run(template, "pnpm", ["build"], { cwd: destination });
  }
  if (manifest.scripts?.["test:smoke"]) {
    await run(template, "pnpm", ["test:smoke"], { cwd: destination });
  }
};

try {
  const packageDirectory = join(repoRoot, "packages", "eve");
  const packedDirectory = join(temporaryDirectory, "packed");
  await run("eve", "pnpm", [
    "--dir",
    packageDirectory,
    "pack",
    "--pack-destination",
    packedDirectory,
  ]);

  const tarballs = readdirSync(packedDirectory).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one eve tarball in ${packedDirectory}, found ${tarballs.join(", ") || "none"}`,
    );
  }
  const tarball = join(packedDirectory, tarballs[0]);

  const templates = readdirSync(templatesDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(templatesDirectory, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort(compareByExpectedDuration);
  if (templates.length === 0) throw new Error(`No templates found in ${templatesDirectory}`);

  // Every template runs even when one fails, so a single run reports every
  // broken template instead of stopping at the first.
  const failures = [];
  let nextIndex = 0;
  const work = async () => {
    while (nextIndex < templates.length) {
      const template = templates[nextIndex++];
      const startedAt = Date.now();
      try {
        await checkTemplate(template, tarball, tarballs[0]);
        process.stdout.write(
          `\n[${template}] PASSED in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
        );
      } catch (error) {
        process.stdout.write(`\n[${template}] FAILED\n`);
        failures.push({ template, error });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_TEMPLATES, templates.length) }, work),
  );

  if (failures.length > 0) {
    const lines = failures.map(
      ({ template, error }) => `[${template}] ${error instanceof Error ? error.message : error}`,
    );
    throw new Error(
      `Template compatibility checks failed for ${failures.length} of ${templates.length} templates:\n${lines.join("\n")}`,
    );
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
