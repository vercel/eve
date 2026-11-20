#!/usr/bin/env node
/**
 * Adds the tools that Vercel CI tasks need and its Linux image lacks. The
 * `ci.bootstrapping.installCommand` in vercel.json runs this after installing
 * dependencies. Each tool lands in the root node_modules/.bin, which pnpm puts
 * on PATH for every package script, and is verified against a pinned SHA-256.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const UV_VERSION = "0.12.17";
const UV_SHA256 = "6401c4665d8fa2a9893e087c91f585430738e3170f5398a1141483efb4a93310";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(
    `install-ci-tools installs Linux x64 tools for Vercel CI, not ${process.platform}-${process.arch}.`,
  );
}

const bin = resolve(import.meta.dirname, "../node_modules/.bin");
const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-musl.tar.gz`;
const response = await fetch(url);
if (!response.ok) throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== UV_SHA256) throw new Error(`${url} has SHA-256 ${digest}, expected ${UV_SHA256}.`);

const work = mkdtempSync(join(tmpdir(), "eve-ci-tools-"));
try {
  writeFileSync(join(work, "uv.tar.gz"), archive);
  execFileSync("tar", ["-xzf", "uv.tar.gz", "--strip-components=1"], { cwd: work });
  mkdirSync(bin, { recursive: true });
  for (const name of ["uv", "uvx"]) {
    copyFileSync(join(work, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
} finally {
  rmSync(work, { force: true, recursive: true });
}
console.log(`Installed uv ${UV_VERSION} in ${bin}`);
