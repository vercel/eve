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
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const templatesDirectory = join(repoRoot, "apps", "templates");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "eve-template-compatibility-"));

const run = (command, args, options = {}) => {
  process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
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
    manifest.dependencies.eve = `file:${tarball}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    process.stdout.write(`\nChecking ${template} against ${tarballs[0]}\n`);
    run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: destination });
    run("pnpm", ["typecheck"], { cwd: destination });
    run("pnpm", ["exec", "eve", "build"], { cwd: destination });
    run("pnpm", ["build"], { cwd: destination });
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
