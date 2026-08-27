#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPATIBILITY_FIXTURE_ROOT,
  COMPATIBILITY_SOURCE,
  REPORT_ROOT,
  REPO_ROOT,
  bumpCapabilityConfiguration,
  parseCapabilityConfiguration,
  retainedCompatibilityFixture,
  toPosix,
  validateCapabilityConfiguration,
} from "./extension-contracts/configuration.mjs";
import { classifyStructuralBackwardCompatibility } from "./extension-contracts/compatibility.mjs";
import {
  checkCapabilityReports,
  generateHistoricalCapabilityReport,
  reportInventoryIssues,
} from "./extension-contracts/reports.mjs";

function gitOutput(args) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function immutableContractHistoryIssues() {
  const protectedPaths = [
    toPosix(relative(REPO_ROOT, REPORT_ROOT)),
    toPosix(relative(REPO_ROOT, COMPATIBILITY_FIXTURE_ROOT)),
  ];
  const comparisons = [
    ["diff", "--name-status", "--", ...protectedPaths],
    ["diff", "--cached", "--name-status", "--", ...protectedPaths],
  ];
  const hasBase = gitOutput(["rev-parse", "--verify", "origin/main"]) !== undefined;
  if (hasBase) {
    comparisons.push(["diff", "--name-status", "origin/main...HEAD", "--", ...protectedPaths]);
  }

  const changes = new Set();
  for (const args of comparisons) {
    for (const line of (gitOutput(args) ?? "").trim().split("\n")) {
      if (line !== "") changes.add(line);
    }
  }

  const issues = [];
  for (const change of changes) {
    const [status, ...paths] = change.split("\t");
    if (status === "A") continue;
    if (
      hasBase &&
      paths.every((path) => gitOutput(["cat-file", "-e", `origin/main:${path}`]) === undefined)
    ) {
      continue;
    }
    if (paths.every((path) => path.endsWith("README.md"))) continue;
    issues.push({
      file: paths.at(-1) ?? protectedPaths[0],
      message: `Published capability metadata and retained compatibility fixtures are immutable (git status ${status}). Bump the capability epoch and add new files instead of changing or deleting existing contract history.`,
    });
  }
  return issues;
}

function formatted(source, path) {
  const require = createRequire(import.meta.url);
  const formatterPackage = require.resolve("oxfmt/package.json");
  const formatter = join(dirname(formatterPackage), "bin/oxfmt");
  return execFileSync(process.execPath, [formatter, "--stdin-filepath", path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: source,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function updateRequest(args) {
  const updateIndex = args.indexOf("--update");
  const capability = updateIndex === -1 ? undefined : args[updateIndex + 1];
  const retain = args.includes("--retain");
  const dropIndex = args.indexOf("--drop");
  const reason = dropIndex === -1 ? undefined : args[dropIndex + 1];
  if (updateIndex !== -1 && (!capability || capability.startsWith("--"))) {
    throw new Error("--update requires a capability name.");
  }
  if (capability === undefined && (retain || dropIndex !== -1)) {
    throw new Error("--retain and --drop require --update <capability>.");
  }
  if (retain && dropIndex !== -1) {
    throw new Error("--retain and --drop cannot be used together.");
  }
  if (dropIndex !== -1 && (!reason || reason.startsWith("--"))) {
    throw new Error("--drop requires a non-empty reason.");
  }
  return capability === undefined
    ? undefined
    : {
        capability,
        decision:
          dropIndex !== -1 ? { retain: false, reason } : retain ? { retain: true } : undefined,
      };
}

async function scaffoldRetainedFixture(capability, version) {
  const path = join(COMPATIBILITY_FIXTURE_ROOT, capability, `v${version}.ts`);
  try {
    await readFile(path);
    return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatted(retainedCompatibilityFixture(capability, version), path), "utf8");
}

export async function checkExtensionCapabilityContracts({ update = false } = {}) {
  const source = await readFile(COMPATIBILITY_SOURCE, "utf8");
  const configuration = parseCapabilityConfiguration(source);
  const issues = await validateCapabilityConfiguration(configuration);
  if (!update) issues.push(...immutableContractHistoryIssues());
  if (issues.length === 0) {
    issues.push(...(await checkCapabilityReports(configuration, update)));
    issues.push(...(await reportInventoryIssues(configuration)));
  }
  return issues;
}

async function main() {
  const args = process.argv.slice(2);
  const request = updateRequest(args);

  if (request !== undefined) {
    const source = await readFile(COMPATIBILITY_SOURCE, "utf8");
    const configuration = parseCapabilityConfiguration(source);
    const initialIssues = [
      ...(await validateCapabilityConfiguration(configuration)),
      ...immutableContractHistoryIssues(),
      ...(await reportInventoryIssues(configuration)),
    ];
    const reportIssues = await checkCapabilityReports(configuration, false);
    const selectedMismatch = reportIssues.find(
      (issue) => issue.kind === "contract-mismatch" && issue.capability === request.capability,
    );
    initialIssues.push(
      ...reportIssues.filter(
        (issue) => issue.kind !== "contract-mismatch" || issue.capability !== request.capability,
      ),
    );
    if (selectedMismatch === undefined) {
      initialIssues.push({
        file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
        message: `Capability "${request.capability}" has no detected API change to bump.`,
      });
    }
    if (initialIssues.length > 0) return initialIssues;

    let decision = request.decision;
    if (decision === undefined) {
      const previousReport = await generateHistoricalCapabilityReport(
        request.capability,
        configuration.current[request.capability],
      );
      const classification = classifyStructuralBackwardCompatibility(
        previousReport,
        selectedMismatch.currentReport,
      );
      if (!classification.compatible) {
        return [
          {
            file: selectedMismatch.file,
            message: `Could not prove the ${request.capability} change is backward compatible. ${classification.reasons.slice(0, 3).join(" ")} Rerun with \`--retain\` after verifying runtime compatibility, or \`--drop "reason"\` to stop accepting the previous epoch.`,
          },
        ];
      }
      decision = { retain: true };
    }

    const bumped = bumpCapabilityConfiguration(source, request.capability, decision);
    await writeFile(COMPATIBILITY_SOURCE, formatted(bumped.source, COMPATIBILITY_SOURCE), "utf8");
    if (decision.retain) {
      await scaffoldRetainedFixture(request.capability, bumped.previousVersion);
    }
    process.stdout.write(
      decision.retain
        ? `[eve:extension-contracts] ${request.capability} is structurally backward compatible; retaining epoch ${bumped.previousVersion} and bumping to ${bumped.version}.\n`
        : `[eve:extension-contracts] dropping ${request.capability} epoch ${bumped.previousVersion} and bumping to ${bumped.version}.\n`,
    );
  }

  const issues = await checkExtensionCapabilityContracts({ update: true });
  return issues;
}

async function run() {
  let issues;
  try {
    issues = await main();
  } catch (error) {
    issues = [
      {
        file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  if (issues.length > 0) {
    process.stderr.write(
      `[eve:extension-contracts] FAIL: ${issues.length} capability contract issue${issues.length === 1 ? "" : "s"}.\n\n`,
    );
    for (const issue of issues) {
      process.stderr.write(`  ${issue.file}\n    ${issue.message}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write("[eve:extension-contracts] updated current capability metadata.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
