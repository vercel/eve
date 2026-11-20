import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const source = path.resolve(import.meta.dirname, "..");
const workspace = path.resolve(source, "../..");
const packageManifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
const development = createRequire(path.join(source, "package.json"));
const developmentVersion = async (name, resolver = development) =>
  JSON.parse(await readFile(resolver.resolve(`${name}/package.json`), "utf8")).version;
const [typescript, nodeTypes, schemaTypes] = await Promise.all([
  developmentVersion("typescript"),
  developmentVersion("@types/node"),
  developmentVersion("@types/json-schema", createRequire(development.resolve("eve/package.json"))),
]);
const directory = await mkdtemp(path.join(tmpdir(), "eve-self-improvement-consumer-"));
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const npm = (args, cwd = directory) => run("npx", ["--yes", "npm@11.6.2", ...args], cwd);
let passed = false;
try {
  const tarball = path.join(directory, "self-improvement.tgz");
  run("pnpm", ["pack", "--config.ignore-scripts=true", "--out", tarball], source);
  const files = run("tar", ["-tzf", tarball], directory)
    .trim()
    .split("\n")
    .map((file) => file.replace(/^package\//, ""));
  assert.ok(
    files.every(
      (file) => !/(?:^|\/)(?:\.env[^/]*|\.eve|node_modules|tests?|scripts)(?:\/|$)/.test(file),
    ),
    "Archive contains private, runtime-state, test, or development files",
  );
  for (const name of ["LICENSE", "NOTICE", "dist/THIRD_PARTY_LICENSES.txt"])
    assert.ok(files.includes(name), `Archive omitted ${name}`);
  const packedManifest = JSON.parse(
    run("tar", ["-xOf", tarball, "package/package.json"], directory),
  );
  assert.equal(packedManifest.name, "@eve/self-improvement");
  assert.equal(packedManifest.dependencies.pg, undefined);
  const [eve] = JSON.parse(
    npm(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      path.join(workspace, "packages/eve/.package"),
    ),
  );
  await mkdir(path.join(directory, "agent", "extensions"), { recursive: true });
  await mkdir(path.join(directory, "agent", "instrumentation"), { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "self-improvement-consumer",
      private: true,
      type: "module",
      packageManager: "npm@11.6.2",
      engines: packageManifest.engines,
      dependencies: {
        eve: `file:./${eve.filename}`,
        "@eve/self-improvement": "file:./self-improvement.tgz",
      },
      devDependencies: {
        typescript,
        "@types/node": nodeTypes,
        "@types/json-schema": schemaTypes,
      },
    }),
  );
  await writeFile(
    path.join(directory, "agent", "agent.ts"),
    'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-6.1-sol-fast" });\n',
  );
  await writeFile(
    path.join(directory, "agent", "instructions.md"),
    "Isolated package fixture. Use the installed tools when requested.\n",
  );
  await writeFile(
    path.join(directory, "agent", "extensions", "self-improvement.ts"),
    `import selfImprovement from "@eve/self-improvement";
export default selfImprovement({
  instance: "consumer-fixture",
  project: { teamId: "team_fixture", projectId: "prj_fixture", productionUrl: "https://fixture.example.com" },
  repository: { owner: "fixture", name: "agent" },
  owner: { authenticator: "fixture", principalId: "fixture" },
  models: { analyst: "openai/gpt-6.1-sol-fast", maintainer: "openai/gpt-6.1-sol" },
  cron: "0 0 31 2 *",
});\n`,
  );
  await writeFile(
    path.join(directory, "agent", "instrumentation", "otel.ts"),
    'export { privateTelemetry as default } from "@eve/self-improvement/telemetry";\n',
  );
  await writeFile(
    path.join(directory, "public-api.ts"),
    `import type { Report, SelfImprovementOptions } from "@eve/self-improvement/core";
export const reportStatus = (report: Report) => report.status;
export const publisher: NonNullable<NonNullable<SelfImprovementOptions["verification"]>["publisher"]> = async ({ sha, deployment }) => ({ name: "publisher identity", status: sha === deployment.sha ? "passed" : "failed", reason: "Compared the actual published source" });
`,
  );
  await writeFile(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      include: ["agent/**/*.ts", "public-api.ts"],
    }),
  );
  npm(["install", "--package-lock-only", "--ignore-scripts"]);
  npm(["ci", "--ignore-scripts"]);
  const consumer = createRequire(path.join(directory, "package.json"));
  assert.throws(
    () => consumer.resolve("pg"),
    { code: "MODULE_NOT_FOUND" },
    "Blob installation pulled in the optional Postgres driver",
  );
  npm(["exec", "--", "tsc", "--noEmit"]);
  const audit = JSON.parse(npm(["audit", "--audit-level=high", "--omit=dev", "--json"]));
  assert.equal(
    audit.metadata.vulnerabilities.high + audit.metadata.vulnerabilities.critical,
    0,
    "Installed runtime dependency audit found high/critical vulnerabilities",
  );
  run(
    process.execPath,
    [
      path.join(directory, "node_modules", "eve", "bin", "eve.js"),
      "build",
      ...(process.env.EVE_SELF_IMPROVEMENT_HOSTED_CONSUMER ? [] : ["--skip-sandbox-prewarm"]),
    ],
    directory,
  );
  const manifest = JSON.parse(
    await readFile(path.join(directory, ".eve", "agent-summary.json"), "utf8"),
  );
  assert.equal(manifest.diagnostics.errors, 0, "Consumer has compilation errors");
  const text = JSON.stringify(manifest);
  for (const contribution of [
    "self-improvement__cycle",
    "self-improvement__doctor",
    "self-improvement__status",
    "self-improvement__coordinator",
    "self-improvement__daily",
  ])
    assert.ok(text.includes(contribution), `Packed consumer omitted ${contribution}`);
  assert.ok(
    text.includes("maintainer") && text.includes("analyst"),
    "Packed consumer omitted nested hosted agents",
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const library = (name) => pathToFileURL(path.join(path.dirname(require.resolve("@eve/self-improvement/package.json")), "dist/extension/lib", name + ".mjs"));
const { configSchema } = await import(library("config"));
const { store, closeStores } = await import(library("store"));
const config = configSchema.parse({ instance: "missing-driver", project: { teamId: "team_fixture", projectId: "prj_fixture", productionUrl: "https://fixture.example.com" }, repository: { owner: "fixture", name: "agent" }, owner: { authenticator: "fixture", principalId: "fixture" }, models: { analyst: "fixture/analyst", maintainer: "fixture/maintainer" }, database: "postgres", databaseUrl: () => "postgresql://fixture.invalid/fixture" });
await assert.rejects(store(config).get("fixture"), /Install pg@/);
await closeStores();`,
    ],
    directory,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      check: "fresh packed consumer install/build",
      postgresDriver: "not installed",
      publicTypes: "passed without skipLibCheck or optional storage SDK types",
      sandboxPrewarm: process.env.EVE_SELF_IMPROVEMENT_HOSTED_CONSUMER
        ? "hosted"
        : "unavailable: offline compilation only; output is not deployable",
      contributions:
        "tools, schedule, coordinator, analyst, maintainer, instrumentation and callback types",
    }),
  );
  passed = true;
} catch (error) {
  console.error(`Packed consumer failed; fixture retained at ${directory}`);
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  if (passed && !process.env.EVE_SELF_IMPROVEMENT_KEEP_CONSUMER)
    await rm(directory, { recursive: true, force: true });
  else if (passed) console.log(`Consumer retained at ${directory}`);
}
