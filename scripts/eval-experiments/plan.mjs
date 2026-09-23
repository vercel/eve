import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getProfile } from "./profiles/index.mjs";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
const SHA = /^[a-f0-9]{40}$/;

export async function createPlan(manifestPath, options = {}) {
  const root = await realpath(resolve(options.root ?? ROOT));
  const manifestFile = await realpath(resolve(manifestPath));
  const bytes = await readFile(manifestFile);
  if (bytes.byteLength > 64 * 1024) throw new Error("Manifest exceeds 64 KiB.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  validateManifest(manifest);
  if (!manifestFile.startsWith(`${resolve(root, "experiments")}${sep}`))
    throw new Error("Manifest must be inside the repository experiments/ directory.");
  const matrix = JSON.parse(await readFile(resolve(root, "e2e/matrix.json"), "utf8"));
  const matrixModels = new Map(
    matrix.models.map((model) => [model.name, { id: model.id, label: model.name }]),
  );
  const profileIds = [...new Set(manifest.fixtures.map((fixture) => fixture.metrics))];
  const profileRegistry = profileIds.map(getProfile);
  const selectedModels = new Map();
  for (const name of manifest.models) {
    const matching = profileRegistry.filter((profile) => profile.supportsModel(name));
    if (matching.length > 1) throw new Error(`Model alias resolves ambiguously: ${name}`);
    const modelSettings = matching[0]?.resolveModel(name) ?? matrixModels.get(name);
    if (!modelSettings) throw new Error(`Unknown model alias: ${name}`);
    selectedModels.set(name, modelSettings);
  }

  const fixturesRoot = await realpath(resolve(root, "e2e/fixtures"));
  const fixtures = [];
  for (const fixture of manifest.fixtures) {
    const fixtureRoot = await realpath(resolve(fixturesRoot, fixture.name));
    if (!fixtureRoot.startsWith(`${fixturesRoot}${sep}`)) throw new Error("Invalid fixture path.");
    const packageJson = JSON.parse(await readFile(resolve(fixtureRoot, "package.json"), "utf8"));
    if (packageJson.name !== fixture.name) throw new Error(`Unknown fixture: ${fixture.name}`);
    const profile = getProfile(fixture.metrics);
    const evalIds = await discoverEvalIds(resolve(fixtureRoot, "evals"));
    profile.validateSelection(fixture.name, fixture.evals, evalIds);
    profile.validateRunArguments?.(fixture.evals, manifest.repetitions);
    fixtures.push({ ...fixture, metricProfile: profile.id, evals: [...fixture.evals] });
  }

  const experimentSha = await git(root, ["rev-parse", "HEAD"]);
  const manifestRelativePath = manifestFile
    .slice(root.length + 1)
    .split(sep)
    .join("/");
  const manifestInExperimentCommit = await git(root, [
    "cat-file",
    "-e",
    `${experimentSha}:${manifestRelativePath}`,
  ]).then(
    () => true,
    () => false,
  );
  if (!manifestInExperimentCommit)
    throw new Error("Manifest must be committed at the dispatched experiment revision.");
  const variants = [manifest.baseline, ...manifest.candidates];
  for (const variant of variants) {
    const exists = await git(root, ["cat-file", "-e", `${variant.sha}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!exists) throw new Error(`Commit is not available locally: ${variant.sha}`);
    if ((await git(root, ["rev-parse", `${variant.sha}^{commit}`])) !== variant.sha)
      throw new Error(`Revision must be a full commit SHA: ${variant.sha}`);
  }
  const diffs = [];
  for (const candidate of manifest.candidates) {
    const changed = await git(root, [
      "diff",
      "--no-renames",
      "--name-only",
      manifest.baseline.sha,
      candidate.sha,
    ]);
    const paths = changed.split("\n").filter(Boolean);
    const profiles = [...new Set(manifest.fixtures.map((fixture) => fixture.metrics))].map(
      getProfile,
    );
    const allowedDiffPaths = new Set(profiles.flatMap((profile) => [...profile.allowedDiffPaths]));
    const configurationPaths = new Set(
      profiles.flatMap((profile) => [...profile.configurationPaths]),
    );
    const disallowed = paths.filter((path) => !allowedDiffPaths.has(path));
    if (disallowed.length)
      throw new Error(
        `Variant ${candidate.label} changes disallowed paths:\n${disallowed.join("\n")}`,
      );
    const patch = (
      await execFile(
        "git",
        [
          "diff",
          "--no-renames",
          "--no-ext-diff",
          manifest.baseline.sha,
          candidate.sha,
          "--",
          ...paths,
        ],
        { cwd: root, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout;
    diffs.push({
      candidate: candidate.label,
      paths,
      patch,
      configurationExperiment: paths.some((path) => configurationPaths.has(path)),
      configurationPaths: paths.filter((path) => configurationPaths.has(path)),
    });
  }

  for (const variant of variants) {
    variant.configurationExperiment = diffs.some(
      (diff) => diff.candidate === variant.label && diff.configurationExperiment,
    );
  }

  const seed = manifest.seed >>> 0;
  const schedules = [];
  const globalBudget = executionsBudget(fixtures, manifest, variants);
  if (globalBudget > 1000)
    throw new Error(`Execution budget exceeds 1000 eval invocations: ${globalBudget}`);
  for (const fixture of fixtures)
    for (const modelName of manifest.models) {
      const modelSettings = selectedModels.get(modelName);
      const rng = seededRandom((seed ^ hash32(`${fixture.name}:${modelName}`)) >>> 0);
      const order = variants.map((v) => v.label);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const offset = Math.floor(rng() * order.length);
      const blocks = Array.from({ length: manifest.repetitions }, (_, repetition) => {
        const rotation = (repetition + offset) % order.length;
        return { repetition, order: [...order.slice(rotation), ...order.slice(0, rotation)] };
      });
      schedules.push({
        fixture: fixture.name,
        model: modelName,
        modelId: modelSettings.id,
        reasoning: modelSettings.reasoning,
        label: modelSettings.label ?? modelName,
        blocks,
      });
    }
  const executions = globalBudget;
  return {
    version: 1,
    experimentSha,
    manifestHash: createHash("sha256").update(bytes).digest("hex"),
    metricProfiles: [...new Set(fixtures.map((fixture) => fixture.metricProfile))].map((id) => ({
      id,
      metricSchemaVersion: getProfile(id).metricSchemaVersion,
      primaryMetric: getProfile(id).primaryMetric,
    })),
    variants,
    diffs,
    fixtures,
    models: manifest.models.map((name) => ({ name, ...selectedModels.get(name) })),
    repetitions: manifest.repetitions,
    seed,
    maxConcurrency: manifest.maxConcurrency,
    executions,
    matrix: schedules,
  };
}

function executionsBudget(fixtures, manifest, variants) {
  return (
    fixtures.reduce((n, fixture) => n + fixture.evals.length, 0) *
    manifest.models.length *
    manifest.repetitions *
    variants.length
  );
}

function validateManifest(m) {
  if (
    !m ||
    m.version !== 1 ||
    !m.baseline ||
    !Array.isArray(m.candidates) ||
    !Array.isArray(m.fixtures) ||
    !Array.isArray(m.models)
  )
    throw new Error("Invalid version 1 experiment manifest.");
  if (m.candidates.length < 1 || m.candidates.length > 5)
    throw new Error("Manifest must have 1–5 candidates.");
  if (!Number.isInteger(m.repetitions) || m.repetitions < 1 || m.repetitions > 30)
    throw new Error("repetitions must be an integer from 1 to 30.");
  if (!Number.isInteger(m.seed) || m.seed < 0 || m.seed > 0xffffffff)
    throw new Error("seed must be an unsigned 32-bit integer.");
  if (!Number.isInteger(m.maxConcurrency) || m.maxConcurrency < 1 || m.maxConcurrency > 10)
    throw new Error("maxConcurrency must be from 1 to 10.");
  if (!m.fixtures.length || m.fixtures.length > 5 || !m.models.length || m.models.length > 5)
    throw new Error("Select 1–5 fixtures and 1–5 models.");
  const variants = [m.baseline, ...m.candidates];
  const labels = new Set();
  for (const v of variants) {
    if (!LABEL.test(v.label ?? "") || labels.has(v.label))
      throw new Error(`Invalid or duplicate variant label: ${v.label}`);
    if (!SHA.test(v.sha ?? ""))
      throw new Error(`Variant ${v.label} must use a full lowercase commit SHA.`);
    labels.add(v.label);
  }
  if (
    new Set(m.models).size !== m.models.length ||
    m.models.some((x) => typeof x !== "string" || !LABEL.test(x))
  )
    throw new Error("Model names must be unique valid identifiers.");
  if (new Set(m.fixtures.map((fixture) => fixture.name)).size !== m.fixtures.length)
    throw new Error("Fixture names must be unique.");
  if (new Set(m.fixtures.map((fixture) => fixture.metrics)).size > 1)
    throw new Error("All fixtures in one experiment must use the same metrics profile.");
  const caseCount = m.fixtures.reduce((sum, f) => {
    if (
      !LABEL.test(f.name ?? "") ||
      typeof f.metrics !== "string" ||
      !Array.isArray(f.evals) ||
      f.evals.length < 1 ||
      f.evals.length > 10
    )
      throw new Error("Invalid fixture selection.");
    if (
      new Set(f.evals).size !== f.evals.length ||
      f.evals.some(
        (id) =>
          typeof id !== "string" ||
          id.length > 120 ||
          id.includes("..") ||
          id.startsWith("/") ||
          !/^[a-zA-Z0-9_/-]+$/.test(id),
      )
    )
      throw new Error("Invalid or duplicate eval id.");
    return sum + f.evals.length;
  }, 0);
  if (caseCount > 20) throw new Error("Select no more than 20 eval cases.");
}

async function discoverEvalIds(root) {
  const ids = new Set();
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".eval.ts"))
        ids.add(path.slice(root.length + 1).replace(/\.eval\.ts$/, ""));
    }
  }
  await visit(root);
  return ids;
}
async function git(root, args) {
  return (await execFile("git", args, { cwd: root, maxBuffer: 1024 * 1024 })).stdout.trim();
}
function hash32(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
function seededRandom(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, output] = process.argv.slice(2);
  if (!manifest || !output) throw new Error("Usage: node plan.mjs <manifest.json> <plan.json>");
  const plan = await createPlan(resolve(manifest));
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(
    `Planned ${plan.executions} eval executions across ${plan.matrix.length} fixture/model jobs.`,
  );
}
