import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CompilerState, Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { readPackageEntries } from "./public-exports.mjs";

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const root = fileURLToPath(new URL("../", import.meta.url));
const eve = join(root, "packages/eve");
const snapshots = join(eve, "public-api");

export async function checkPublicSignatures({ write = false } = {}) {
  execFileSync(process.execPath, [join(eve, "scripts/vendor-compiled.mjs")], {
    cwd: eve,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries = await readPackageEntries();
  const selfReferences = await readPackageEntries({ includeInternal: true });
  const scratch = await mkdtemp(join(tmpdir(), "eve-public-signatures-"));
  try {
    const declarations = join(scratch, "declarations");
    // Emit with the same compiler and config as the published package, not the
    // older TypeScript bundled with API Extractor.
    const configPath = join(scratch, "tsconfig.json");
    await writeFile(
      configPath,
      JSON.stringify({
        extends: join(eve, "tsconfig.build.json"),
        compilerOptions: {
          outDir: declarations,
          declarationMap: false,
          typeRoots: [join(eve, "node_modules/@types"), join(root, "node_modules/@types")],
          // Self-imports must not resolve to an earlier dist build.
          paths: Object.fromEntries(
            [...selfReferences].map(([entry, source]) => [entry, [source]]),
          ),
        },
      }),
    );
    execFileSync(process.execPath, [tsc, "-p", configPath], {
      cwd: eve,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // tsc does not emit handwritten declarations, including the compatibility entry.
    for (const sourcePath of await readdir(join(eve, "src"), { recursive: true })) {
      if (!sourcePath.endsWith(".d.ts")) continue;
      const destination = join(declarations, "src", sourcePath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(eve, "src", sourcePath), destination);
    }
    await cp(join(eve, ".generated/compiled"), join(declarations, "compiled"), { recursive: true });
    await symlink(join(eve, "node_modules"), join(declarations, "node_modules"), "junction");
    const declarationEntries = new Map(
      [...entries].map(([entry, source]) => [
        entry,
        join(declarations, relative(eve, source).replace(/(?<!\.d)\.ts$/, ".d.ts")),
      ]),
    );
    const manifest = JSON.parse(await readFile(join(eve, "package.json"), "utf8"));
    await writeFile(
      join(declarations, "package.json"),
      JSON.stringify({
        ...manifest,
        imports: { "#compiled/*": "./compiled/*", "#*.js": "./src/*.js" },
        exports: Object.fromEntries(
          [...declarationEntries].map(([entry, file]) => [
            entry === "eve" ? "." : `.${entry.slice(3)}`,
            { types: `./${relative(declarations, file).replaceAll("\\", "/")}` },
          ]),
        ),
      }),
    );
    const issues = [];
    const expectedPaths = new Set();
    let compilerState;
    for (const [entry, mainEntryPointFilePath] of declarationEntries) {
      const report = join(snapshots, `${entry}.api.md`);
      expectedPaths.add(report);
      const extractorConfig = ExtractorConfig.prepare({
        configObject: {
          projectFolder: declarations,
          mainEntryPointFilePath,
          newlineKind: "lf",
          compiler: {
            overrideTsconfig: {
              compilerOptions: {
                module: "NodeNext",
                moduleResolution: "NodeNext",
                target: "ES2024",
                types: ["node"],
                skipLibCheck: true,
              },
              files: [...declarationEntries.values()],
            },
          },
          apiReport: {
            enabled: true,
            reportFileName: basename(entry),
            reportFolder: dirname(report),
            reportTempFolder: join(scratch, "reports", dirname(entry)),
            includeForgottenExports: true,
          },
          docModel: { enabled: false },
          dtsRollup: { enabled: false },
          tsdocMetadata: { enabled: false },
          messages: {
            extractorMessageReporting: { default: { logLevel: "none", addToApiReportFile: false } },
            tsdocMessageReporting: { default: { logLevel: "none" } },
          },
        },
        configObjectFullPath: undefined,
        packageJsonFullPath: join(declarations, "package.json"),
      });
      compilerState ??= CompilerState.create(extractorConfig, {
        additionalEntryPoints: [...declarationEntries.values()],
      });
      const errors = [];
      const result = Extractor.invoke(extractorConfig, {
        compilerState,
        localBuild: write,
        messageCallback(message) {
          message.handled = true;
          if (message.logLevel === "error") errors.push(message.text);
        },
      });
      if (result.errorCount) throw new Error(`${entry}: ${errors.join("\n")}`);
      // API Extractor leaves equivalent reports untouched, including older line endings.
      if (write) await writeFile(report, (await readFile(report, "utf8")).replaceAll("\r\n", "\n"));
      if (!write && result.apiReportChanged)
        issues.push({
          file: relative(root, report),
          message: `${entry} signature changed. Review the API change and run node scripts/public-signatures.mjs --write.`,
        });
    }
    for (const name of await readdir(snapshots, { recursive: true })) {
      if (!name.endsWith(".api.md")) continue;
      const file = join(snapshots, name);
      if (expectedPaths.has(file)) continue;
      if (write) await rm(file);
      else
        issues.push({
          file: relative(root, file),
          message:
            "Signature report has no public package entry. Review its removal and run node scripts/public-signatures.mjs --write.",
        });
    }
    return issues;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some((arg) => arg !== "--write"))
    throw new Error("Usage: node scripts/public-signatures.mjs [--write]");
  const write = process.argv.includes("--write");
  const issues = await checkPublicSignatures({ write });
  for (const issue of issues) process.stderr.write(`${issue.file}: ${issue.message}\n`);
  if (issues.length) process.exitCode = 1;
  else
    process.stdout.write(
      `[eve:public-signatures] ${write ? "updated" : "ok"} — public signatures match.\n`,
    );
}
