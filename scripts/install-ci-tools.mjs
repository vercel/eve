#!/usr/bin/env node
/**
 * Adds the tools that Vercel CI tasks need and its Linux image lacks: uv for the
 * template checks, and the Node.js release in .nvmrc, because the image ships an
 * older Node.js. The `ci.bootstrapping.installCommand` in vercel.json runs this
 * after installing dependencies. Each tool lands in the root node_modules/.bin,
 * which pnpm puts first on PATH for every package script, and is verified
 * against a pinned SHA-256.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_VERSION = "26.13.1";
const TOOLS = [
  {
    name: "uv",
    version: "0.12.17",
    url: "https://github.com/astral-sh/uv/releases/download/0.12.17/uv-x86_64-unknown-linux-musl.tar.gz",
    sha256: "6401c4665d8fa2a9893e087c91f585430738e3170f5398a1141483efb4a93310",
    files: { uv: "uv", uvx: "uvx" },
  },
  {
    name: "Node.js",
    version: NODE_VERSION,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
    sha256: "5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864",
    files: { node: "bin/node" },
  },
];

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(
    `install-ci-tools installs Linux x64 tools for Vercel CI, not ${process.platform}-${process.arch}.`,
  );
}

const root = resolve(import.meta.dirname, "..");
const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
if (nvmrc !== NODE_VERSION) {
  throw new Error(
    `.nvmrc pins Node.js ${nvmrc}, but install-ci-tools.mjs installs ${NODE_VERSION}. Set NODE_VERSION and its SHA-256, from that release's signed SHASUMS256.txt, to match.`,
  );
}

const bin = join(root, "node_modules", ".bin");
mkdirSync(bin, { recursive: true });
for (const tool of TOOLS) {
  const response = await fetch(tool.url);
  if (!response.ok) throw new Error(`Downloading ${tool.url} failed with HTTP ${response.status}.`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== tool.sha256) {
    throw new Error(`${tool.url} has SHA-256 ${digest}, expected ${tool.sha256}.`);
  }
  const work = mkdtempSync(join(tmpdir(), "eve-ci-tools-"));
  try {
    writeFileSync(join(work, "archive"), archive);
    execFileSync("tar", ["-xf", "archive", "--strip-components=1"], { cwd: work });
    for (const [name, path] of Object.entries(tool.files)) {
      copyFileSync(join(work, path), join(bin, name));
      chmodSync(join(bin, name), 0o755);
    }
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
  console.log(`Installed ${tool.name} ${tool.version} in ${bin}`);
}

const nodeVersion = execFileSync(join(bin, "node"), ["--version"], { encoding: "utf8" }).trim();
if (nodeVersion !== `v${NODE_VERSION}`) {
  throw new Error(`${join(bin, "node")} reports ${nodeVersion}, expected v${NODE_VERSION}.`);
}
