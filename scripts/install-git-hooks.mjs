#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const gitProbe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});

if (gitProbe.status !== 0 || gitProbe.stdout.trim() !== "true") process.exit(0);

const result = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
