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
import { execFileSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const templatesDirectory = join(repoRoot, "apps", "templates");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "eve-template-compatibility-"));

// Vercel Framework Preset slugs a template web service may deploy under. Vercel rejects unknown
// slugs at deploy time, and eve's own host names differ from them (Nuxt is "nuxtjs", not "nuxt").
const VERCEL_WEB_FRAMEWORKS = new Set(["nextjs", "nuxtjs", "sveltekit", "tanstack-start"]);

const run = (command, args, options = {}) => {
  process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
};

/**
 * Deploy with Vercel clones a template from main and installs its committed lockfile, so the
 * template must typecheck with the published eve release that lockfile pins, not only with the
 * packed eve checked afterwards.
 */
const checkCommittedLockfile = (destination) => {
  run("pnpm", ["install", "--frozen-lockfile"], { cwd: destination });
  run("pnpm", ["typecheck"], { cwd: destination });
};

/**
 * Builds each authored `vercel.ts` service the way Vercel does: from the service root, where a
 * root-only pnpm install puts no framework binary on PATH. The template's own `pnpm build` runs
 * from the project root and cannot catch a service that only builds there.
 */
const checkVercelServices = (template, destination) => {
  if (!existsSync(join(destination, "vercel.ts"))) return;
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
    if (existsSync(join(serviceRoot, "package.json"))) continue;
    if (!service.buildCommand) {
      throw new Error(
        `${label} has no package.json in ${service.root}, so Vercel cannot find the framework binary. Set buildCommand to run it from the root node_modules.`,
      );
    }
    process.stdout.write(`$ (cd ${service.root} && ${service.buildCommand})\n`);
    execFileSync("sh", ["-c", service.buildCommand], {
      cwd: serviceRoot,
      env: { ...process.env, PATH: path },
      stdio: "inherit",
    });
  }
};

try {
  const packageDirectory = join(repoRoot, "packages", "eve");
  const packedDirectory = join(temporaryDirectory, "packed");
  run("pnpm", ["--dir", packageDirectory, "pack", "--pack-destination", packedDirectory]);

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
    .sort();
  if (templates.length === 0) throw new Error(`No templates found in ${templatesDirectory}`);

  for (const template of templates) {
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

    process.stdout.write(`\nChecking ${template} with its committed lockfile\n`);
    checkCommittedLockfile(destination);

    manifest.dependencies.eve = `file:${tarball}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    process.stdout.write(`\nChecking ${template} against ${tarballs[0]}\n`);
    run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: destination });
    run("pnpm", ["typecheck"], { cwd: destination });
    // Preparing a Vercel Sandbox snapshot needs Vercel credentials, which this
    // check does not have. Such templates build with `eve build` alone.
    const sandboxPath = join(destination, "agent", "sandbox.ts");
    const vercelSandbox =
      existsSync(sandboxPath) && readFileSync(sandboxPath, "utf8").includes("eve/sandbox/vercel");
    if (vercelSandbox) {
      run("pnpm", ["exec", "eve", "build", "--skip-sandbox-prewarm"], { cwd: destination });
    } else {
      run("pnpm", ["exec", "eve", "build"], { cwd: destination });
      run("pnpm", ["build"], { cwd: destination });
    }
    checkVercelServices(template, destination);
    if (manifest.scripts?.["test:smoke"]) {
      run("pnpm", ["test:smoke"], { cwd: destination });
    }
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
