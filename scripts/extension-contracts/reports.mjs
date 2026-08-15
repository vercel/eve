import { CompilerState, Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  CONTRACT_ROOT,
  ENTRYPOINT_ROOT,
  EVE_ROOT,
  PUBLIC_SURFACES,
  REPORT_ROOT,
  REPO_ROOT,
  collectExportNames,
  toPosix,
} from "./configuration.mjs";
import { collectReportDeclarationNames } from "./compatibility.mjs";

async function* walkFiles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    if (entry.isFile()) yield path;
  }
}

function relativeModuleSpecifier(fromFile, targetFile) {
  const path = toPosix(relative(dirname(fromFile), targetFile));
  return path.startsWith(".") ? path : `./${path}`;
}

function formatSnapshot(snapshot, snapshotPath) {
  const require = createRequire(import.meta.url);
  const formatterPackage = require.resolve("oxfmt/package.json");
  const formatter = join(dirname(formatterPackage), "bin/oxfmt");
  return execFileSync(process.execPath, [formatter, "--stdin-filepath", snapshotPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: snapshot,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function rewriteDeclarationSpecifiers(declarationRoot) {
  for await (const path of walkFiles(declarationRoot)) {
    if (!path.endsWith(".d.ts")) continue;
    const original = await readFile(path, "utf8");
    const rewritten = original
      .replace(/(["'])(#[^"']+)\1/g, (_match, quote, specifier) => {
        const target = specifier.startsWith("#compiled/")
          ? join(declarationRoot, "compiled", specifier.slice("#compiled/".length))
          : join(declarationRoot, "src", specifier.slice(1));
        return `${quote}${relativeModuleSpecifier(path, target)}${quote}`;
      })
      .replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, (_match, quote, specifier) => {
        return `${quote}${specifier}.js${quote}`;
      });
    if (rewritten !== original) await writeFile(path, rewritten, "utf8");
  }
}

async function emitDeclarations(tempRoot, { contractRoot, eveRoot }) {
  const declarationRoot = join(tempRoot, "declarations");
  await mkdir(declarationRoot, { recursive: true });
  execFileSync(process.execPath, [join(eveRoot, "scripts/vendor-compiled.mjs")], {
    cwd: eveRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const require = createRequire(import.meta.url);
  const typescriptPackage = require.resolve("typescript/package.json");
  const tsc = join(dirname(typescriptPackage), "bin/tsc");
  execFileSync(
    process.execPath,
    [
      tsc,
      "-p",
      join(contractRoot, "tsconfig.json"),
      "--outDir",
      declarationRoot,
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
      "--removeComments",
      "true",
      "--pretty",
      "false",
    ],
    { cwd: eveRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  await cp(join(eveRoot, ".generated/compiled"), join(declarationRoot, "compiled"), {
    recursive: true,
  });
  await rewriteDeclarationSpecifiers(declarationRoot);

  const packageJson = JSON.parse(await readFile(join(eveRoot, "package.json"), "utf8"));
  packageJson.name = "eve-extension-contracts";
  packageJson.version = "0.0.0";
  packageJson.private = true;
  packageJson.types = "./extension-contracts/entrypoints/extension.d.ts";
  delete packageJson.exports;
  delete packageJson.imports;
  await writeFile(
    join(declarationRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  return declarationRoot;
}

function extractorConfig({ capabilities, capability, declarationRoot, tempRoot }) {
  const reportFolder = join(tempRoot, "generated-reports", capability);
  const reportTempFolder = join(tempRoot, "temporary-reports", capability);
  return {
    reportFolder,
    reportTempFolder,
    config: ExtractorConfig.prepare({
      configObject: {
        projectFolder: declarationRoot,
        mainEntryPointFilePath: join(
          declarationRoot,
          "extension-contracts/entrypoints",
          `${capability}.d.ts`,
        ),
        newlineKind: "lf",
        testMode: true,
        compiler: {
          overrideTsconfig: {
            compilerOptions: {
              lib: ["ES2024", "DOM", "DOM.Iterable"],
              module: "NodeNext",
              moduleResolution: "NodeNext",
              skipLibCheck: true,
              strict: true,
              target: "ES2024",
              types: ["node"],
            },
            files: capabilities.map((name) =>
              join(declarationRoot, "extension-contracts/entrypoints", `${name}.d.ts`),
            ),
          },
          skipLibCheck: true,
        },
        apiReport: {
          enabled: true,
          includeForgottenExports: true,
          reportFileName: "current",
          reportFolder,
          reportTempFolder,
        },
        docModel: { enabled: false },
        dtsRollup: { enabled: false },
        tsdocMetadata: { enabled: false },
        messages: {
          compilerMessageReporting: { default: { logLevel: "error" } },
          extractorMessageReporting: { default: { logLevel: "none" } },
          tsdocMessageReporting: { default: { logLevel: "none" } },
        },
      },
      configObjectFullPath: undefined,
      packageJsonFullPath: join(declarationRoot, "package.json"),
    }),
  };
}

export async function generateCapabilityReports(
  configuration,
  { contractRoot = CONTRACT_ROOT, eveRoot = EVE_ROOT } = {},
) {
  const cacheRoot = join(EVE_ROOT, ".extension-contracts-cache");
  await mkdir(cacheRoot, { recursive: true });
  const tempRoot = await mkdtemp(join(cacheRoot, "extension-contracts-"));
  try {
    const declarationRoot = await emitDeclarations(tempRoot, { contractRoot, eveRoot });
    const capabilities = Object.keys(configuration.current);
    const configs = [];
    for (const [capability, version] of Object.entries(configuration.current)) {
      const item = extractorConfig({ capabilities, capability, declarationRoot, tempRoot });
      await mkdir(item.reportFolder, { recursive: true });
      await mkdir(item.reportTempFolder, { recursive: true });
      configs.push({ capability, version, ...item });
    }
    const entrypoints = configs.map((item) => item.config.mainEntryPointFilePath);
    const compilerState = CompilerState.create(configs[0].config, {
      additionalEntryPoints: entrypoints.slice(1),
    });

    const reports = new Map();
    for (const item of configs) {
      const messages = [];
      const result = Extractor.invoke(item.config, {
        compilerState,
        localBuild: true,
        printApiReportDiff: false,
        messageCallback(message) {
          if (message.logLevel === "error") messages.push(message.formatMessageWithoutLocation());
          message.handled = true;
        },
      });
      if (!result.succeeded) {
        throw new Error(
          messages[0] ?? `Could not extract the ${item.capability} API for epoch ${item.version}.`,
        );
      }
      reports.set(
        item.capability,
        await readFile(join(item.reportFolder, "current.api.md"), "utf8"),
      );
    }
    return reports;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function gitOutput(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Regenerates an epoch's API report from the Git commit that last recorded its metadata. */
export async function generateHistoricalCapabilityReport(capability, version) {
  const metadataPath = join(REPORT_ROOT, capability, `v${version}.json`);
  const metadataRelativePath = toPosix(relative(REPO_ROOT, metadataPath));
  const baselineCommit = gitOutput(["log", "-1", "--format=%H", "--", metadataRelativePath])
    .split("\n")
    .find(Boolean);
  if (baselineCommit === undefined) {
    throw new Error(
      `Could not find the Git commit that recorded ${metadataRelativePath}. Commit the current epoch metadata before classifying another capability change.`,
    );
  }

  const cacheRoot = join(EVE_ROOT, ".extension-contracts-cache");
  await mkdir(cacheRoot, { recursive: true });
  const historyRoot = await mkdtemp(join(cacheRoot, "history-"));
  const worktreeRoot = join(historyRoot, "worktree");
  let addedWorktree = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreeRoot, baselineCommit], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    addedWorktree = true;
    const historicalEveRoot = join(worktreeRoot, "packages/eve");
    const historicalContractRoot = join(historicalEveRoot, "extension-contracts");
    await symlink(join(EVE_ROOT, "node_modules"), join(historicalEveRoot, "node_modules"), "dir");
    const historicalCapabilities = (await readdir(join(historicalContractRoot, "entrypoints")))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.slice(0, -3));
    const historicalConfiguration = {
      current: Object.fromEntries(historicalCapabilities.map((name) => [name, 1])),
    };
    const reports = await generateCapabilityReports(historicalConfiguration, {
      contractRoot: historicalContractRoot,
      eveRoot: historicalEveRoot,
    });
    const report = reports.get(capability);
    if (report === undefined) {
      throw new Error(
        `The Git baseline ${baselineCommit} does not contain capability "${capability}".`,
      );
    }
    return report;
  } finally {
    if (addedWorktree) {
      execFileSync("git", ["worktree", "remove", "--force", worktreeRoot], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    await rm(historyRoot, { recursive: true, force: true });
  }
}

export async function checkCapabilityReports(configuration, update) {
  const issues = [];
  try {
    const reports = await generateCapabilityReports(configuration);
    for (const surface of PUBLIC_SURFACES) {
      const publicSource = await readFile(join(EVE_ROOT, surface.path), "utf8");
      const publicNames = collectExportNames(publicSource);
      const publicValues = collectExportNames(publicSource, { valuesOnly: true });
      const tracedNames = new Set();
      for (const capability of surface.capabilities) {
        const report = reports.get(capability);
        if (report === undefined) continue;
        for (const name of collectReportDeclarationNames(report)) tracedNames.add(name);
      }
      const missingTypes = [...publicNames]
        .filter((name) => !publicValues.has(name) && !tracedNames.has(name))
        .sort();
      if (missingTypes.length > 0) {
        issues.push({
          file: toPosix(relative(REPO_ROOT, join(EVE_ROOT, surface.path))),
          message: `Public extension types are not reachable from the ${surface.capabilities.join("/")} authoring roots: ${missingTypes.join(", ")}. Add only these standalone types to the appropriate capability entrypoint.`,
        });
      }
    }
    for (const [capability, version] of Object.entries(configuration.current)) {
      const generatedReport = reports.get(capability);
      if (generatedReport === undefined) {
        throw new Error(`Could not generate the ${capability} API for epoch ${version}.`);
      }
      const contractSource = await readFile(join(ENTRYPOINT_ROOT, `${capability}.ts`), "utf8");
      const metadataPath = join(REPORT_ROOT, capability, `v${version}.json`);
      const snapshot = formatSnapshot(
        JSON.stringify({
          kind: "eve-extension-capability-contract",
          capability,
          epoch: version,
          sha256: createHash("sha256").update(generatedReport).digest("hex"),
          exports: [...collectExportNames(contractSource)].sort(),
        }),
        metadataPath,
      );
      let existingMetadata;
      try {
        existingMetadata = await readFile(metadataPath, "utf8");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }

      if (update && existingMetadata === undefined) {
        await mkdir(dirname(metadataPath), { recursive: true });
        await writeFile(metadataPath, snapshot, "utf8");
      } else if (existingMetadata !== snapshot) {
        issues.push({
          capability,
          currentReport: generatedReport,
          kind: "contract-mismatch",
          file: toPosix(relative(REPO_ROOT, metadataPath)),
          message: `The ${capability} API no longer matches epoch ${version}. Run \`pnpm update:extension-contracts --update ${capability}\` to classify the change and add the new epoch metadata.`,
        });
      }
    }
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : undefined;
    issues.push({
      file: toPosix(relative(REPO_ROOT, CONTRACT_ROOT)),
      message: `Could not generate extension capability reports: ${stderr || (error instanceof Error ? error.message : String(error))}`,
    });
  }
  return issues;
}

export async function reportInventoryIssues(configuration) {
  const issues = [];
  const entries = await readdir(REPORT_ROOT, { withFileTypes: true });
  const reportCapabilities = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const configuredCapabilities = Object.keys(configuration.current).sort();
  if (JSON.stringify(reportCapabilities) !== JSON.stringify(configuredCapabilities)) {
    issues.push({
      file: toPosix(relative(REPO_ROOT, REPORT_ROOT)),
      message: `Report directories must exactly match configured capabilities. Expected ${configuredCapabilities.join(", ")}; found ${reportCapabilities.join(", ")}.`,
    });
  }

  for (const [capability, currentVersion] of Object.entries(configuration.current)) {
    const expectedReportNames = Array.from(
      { length: currentVersion },
      (_, index) => `v${index + 1}.json`,
    ).sort();
    const actualReportNames = (
      await readdir(join(REPORT_ROOT, capability), { withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    if (JSON.stringify(actualReportNames) !== JSON.stringify(expectedReportNames)) {
      issues.push({
        file: toPosix(relative(REPO_ROOT, join(REPORT_ROOT, capability))),
        message: `Capability ${capability} metadata must cover every epoch from 1 through ${currentVersion}. Expected ${expectedReportNames.join(", ")}; found ${actualReportNames.join(", ")}.`,
      });
    }
    for (let version = 1; version <= currentVersion; version++) {
      const reportPath = join(REPORT_ROOT, capability, `v${version}.json`);
      try {
        await readFile(reportPath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          issues.push({
            file: toPosix(relative(REPO_ROOT, reportPath)),
            message: `Capability ${capability} is at epoch ${currentVersion}, so immutable metadata v${version}.json must be retained. Restore it or bump epochs sequentially and generate the missing metadata.`,
          });
          continue;
        }
        throw error;
      }
    }
  }
  return issues;
}
