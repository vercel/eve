import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
const SHA = /^[a-f0-9]{40}$/;
const REASONING = new Set([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export async function createPlan(definitionPath, options = {}) {
  const root = await realpath(resolve(options.root ?? ROOT));
  const definitionFile = await realpath(resolve(definitionPath));
  if (!definitionFile.startsWith(`${resolve(root, "experiments")}${sep}`))
    throw new Error("Experiment definition must be inside experiments/.");
  const sourceBytes = await readFile(definitionFile);
  if (sourceBytes.byteLength > 64 * 1024) throw new Error("Experiment definition exceeds 64 KiB.");
  const definition = (await import(pathToFileURL(definitionFile).href)).default;
  validateDefinition(definition);
  const importedModules = await resolveImportedModules(
    root,
    definitionFile,
    sourceBytes.toString("utf8"),
  );

  const revision = await git(root, ["rev-parse", "HEAD"]);
  const relativeDefinition = definitionFile
    .slice(root.length + 1)
    .split(sep)
    .join("/");
  await git(root, ["cat-file", "-e", `${revision}:${relativeDefinition}`]);
  const status = await git(root, ["status", "--porcelain", "--", relativeDefinition]);
  if (status)
    throw new Error(
      "Experiment definition must be committed and clean at the dispatched revision.",
    );

  const sources = [];
  const sourceEntries = definition.matrix.source ?? { head: { revision } };
  for (const [label, entry] of Object.entries(sourceEntries)) {
    if (!LABEL.test(label) || !SHA.test(entry.revision))
      throw new Error(`Invalid source entry: ${label}`);
    const sha = await git(root, ["rev-parse", `${entry.revision}^{commit}`]);
    if (sha !== entry.revision) throw new Error(`Source ${label} must use a full commit SHA.`);
    sources.push({ label, sha });
  }
  const configurations = Object.entries(definition.matrix.configuration).map(
    ([label, settings]) => {
      if (!LABEL.test(label)) throw new Error(`Invalid configuration label: ${label}`);
      return { label, settings: mergeSettings(definition.settings ?? {}, settings) };
    },
  );
  const fixturesRoot = await realpath(resolve(root, "e2e/fixtures"));
  const fixtures = [];
  for (const selection of definition.evals) {
    const fixtureRoot = await realpath(resolve(fixturesRoot, selection.fixture));
    if (!fixtureRoot.startsWith(`${fixturesRoot}${sep}`)) throw new Error("Invalid fixture path.");
    const pkg = JSON.parse(await readFile(resolve(fixtureRoot, "package.json"), "utf8"));
    if (pkg.name !== selection.fixture) throw new Error(`Unknown fixture: ${selection.fixture}`);
    const discovered = await discoverEvalIds(resolve(fixtureRoot, "evals"));
    for (const id of selection.include)
      if (!discovered.has(id))
        throw new Error(`Unknown or unsupported eval ${id} in ${selection.fixture}`);
    fixtures.push({ name: selection.fixture, evals: [...selection.include] });
  }
  if (
    new Set(fixtures.map((item) => item.name)).size !== 1 &&
    definition.analysis.compare.axis === "source"
  )
    throw new Error("Source comparisons require one shared fixture identity.");

  const measurementBundles = {};
  for (const [namespace, bundle] of Object.entries(definition.measurements)) {
    if (
      !LABEL.test(namespace) ||
      !Number.isInteger(bundle.version) ||
      typeof bundle.derive !== "function"
    )
      throw new Error(`Invalid measurement bundle: ${namespace}`);
    measurementBundles[namespace] = {
      version: bundle.version,
      metrics: bundle.metrics,
    };
  }
  const metricNames = Object.entries(measurementBundles).flatMap(([namespace, bundle]) =>
    Object.keys(bundle.metrics).map((name) => `${namespace}.${name}`),
  );
  if (!metricNames.includes(definition.analysis.primaryMetric))
    throw new Error("primaryMetric is not declared by a measurement bundle.");
  const axisEntries = definition.analysis.compare.axis === "source" ? sources : configurations;
  if (
    axisEntries.length < 2 ||
    !axisEntries.some((item) => item.label === definition.analysis.compare.baseline)
  )
    throw new Error("Compared axis must include its baseline and at least one other entry.");
  const fixedEntries = definition.analysis.compare.axis === "source" ? configurations : sources;
  const seed = definition.sampling.seed >>> 0;
  const schedule = [];
  for (const fixed of fixedEntries) {
    const rng = seededRandom((seed ^ hash32(fixed.label)) >>> 0);
    const order = axisEntries.map((item) => item.label);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const offset = Math.floor(rng() * order.length);
    for (let repetition = 0; repetition < definition.sampling.repetitions; repetition++) {
      const rotation = (repetition + offset) % order.length;
      const blockOrder = [...order.slice(rotation), ...order.slice(0, rotation)];
      for (const [executionOrder, compared] of blockOrder.entries()) {
        const source = definition.analysis.compare.axis === "source" ? compared : fixed.label;
        const configuration =
          definition.analysis.compare.axis === "source" ? fixed.label : compared;
        for (const fixture of fixtures)
          for (const evalId of fixture.evals)
            schedule.push({
              source,
              configuration,
              fixture: fixture.name,
              eval: evalId,
              repetition,
              executionOrder,
            });
      }
    }
  }
  const cells = schedule.length;
  if (cells > 1000) throw new Error(`Execution budget exceeds 1000 eval invocations: ${cells}`);
  const diffs = [];
  const sourceBaseline =
    definition.analysis.compare.axis === "source"
      ? sources.find((item) => item.label === definition.analysis.compare.baseline)
      : sources[0];
  if (definition.analysis.compare.axis === "source" && !sourceBaseline)
    throw new Error("Comparison baseline is not a source entry.");
  if (
    definition.analysis.compare.axis === "configuration" &&
    !configurations.some((item) => item.label === definition.analysis.compare.baseline)
  )
    throw new Error("Comparison baseline is not a configuration entry.");
  for (const candidate of sources.filter((item) => item.label !== sourceBaseline?.label)) {
    const paths = (
      await git(root, ["diff", "--no-renames", "--name-only", sourceBaseline.sha, candidate.sha])
    )
      .split("\n")
      .filter(Boolean);
    diffs.push({
      candidate: candidate.label,
      paths,
      patch: (
        await execFile(
          "git",
          ["diff", "--no-renames", "--no-ext-diff", sourceBaseline.sha, candidate.sha],
          { cwd: root, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    });
  }
  const hashInput = JSON.stringify({
    revision,
    definition: relativeDefinition,
    sourceBytes: sourceBytes.toString("base64"),
    sources,
    configurations,
    fixtures,
    measurementBundles,
    importedModules,
    schedule,
  });
  const plan = {
    version: 2,
    experimentRevision: revision,
    definitionPath: relativeDefinition,
    planHash: createHash("sha256").update(hashInput).digest("hex"),
    implementationRevision: revision,
    sources,
    configurations,
    fixtures,
    fixtureIdentity: fixtures.map((item) => item.name).join(","),
    measurementBundles,
    measurementImplementation: importedModules,
    analysis: definition.analysis,
    sampling: definition.sampling,
    maxConcurrency: definition.execution.maxConcurrency,
    schedule,
    diffs,
    executions: cells,
  };
  return plan;
}

export function validateDefinition(d) {
  if (
    !d ||
    !Array.isArray(d.evals) ||
    !d.evals.length ||
    !d.matrix?.configuration ||
    !d.measurements ||
    !d.sampling ||
    !d.execution ||
    !d.analysis
  )
    throw new Error("Invalid experiment definition.");
  const scopes = [
    ...Object.keys(d.settings ?? {}),
    ...Object.values(d.matrix.configuration).flatMap((value) => Object.keys(value ?? {})),
  ];
  for (const scope of scopes)
    if (!["parent", "selfModification"].includes(scope))
      throw new Error(`Unsupported settings scope: ${scope}`);
  const reps = d.sampling.repetitions;
  if (!Number.isInteger(reps) || reps < 1 || reps > 30)
    throw new Error("repetitions must be an integer from 1 to 30.");
  if (!Number.isInteger(d.sampling.seed) || d.sampling.seed < 0 || d.sampling.seed > 0xffffffff)
    throw new Error("seed must be an unsigned 32-bit integer.");
  if (
    !Number.isInteger(d.execution.maxConcurrency) ||
    d.execution.maxConcurrency < 1 ||
    d.execution.maxConcurrency > 10
  )
    throw new Error("maxConcurrency must be from 1 to 10.");
  if (d.evals.length > 5 || d.evals.reduce((sum, f) => sum + f.include.length, 0) > 20)
    throw new Error("Selection exceeds experiment limits.");
  if (
    d.matrix.source !== undefined &&
    (!d.matrix.source ||
      typeof d.matrix.source !== "object" ||
      Array.isArray(d.matrix.source) ||
      !Object.keys(d.matrix.source).length)
  )
    throw new Error("matrix.source must be omitted or a non-empty named map.");
  if (
    Object.keys(d.matrix.source ?? {}).length > 6 ||
    Object.keys(d.matrix.configuration).length > 10
  )
    throw new Error("Matrix exceeds source/configuration entry limits.");
  for (const selection of d.evals) {
    if (
      !selection ||
      typeof selection.fixture !== "string" ||
      !Array.isArray(selection.include) ||
      !selection.include.length
    )
      throw new Error("Invalid eval selection.");
    if (
      new Set(selection.include).size !== selection.include.length ||
      selection.include.some(
        (id) =>
          typeof id !== "string" ||
          id.length > 120 ||
          id.includes("..") ||
          !/^[a-zA-Z0-9_/-]+$/.test(id),
      )
    )
      throw new Error("Invalid or duplicate eval id.");
  }
  const settingGroups = [d.settings ?? {}, ...Object.values(d.matrix.configuration)];
  for (const group of settingGroups)
    for (const [scope, settings] of Object.entries(group ?? {})) {
      if (!["parent", "selfModification"].includes(scope))
        throw new Error(`Unsupported settings scope: ${scope}`);
      if (!settings || typeof settings !== "object")
        throw new Error(`Settings for ${scope} must be an object.`);
      if (Object.keys(settings).some((field) => !["model", "reasoning"].includes(field)))
        throw new Error(`Unsupported setting in ${scope}.`);
      if (
        settings.model !== undefined &&
        (typeof settings.model !== "string" || !settings.model.length)
      )
        throw new Error("model must be a full model ID string.");
      if (settings.reasoning !== undefined && !REASONING.has(settings.reasoning))
        throw new Error(`Invalid eve reasoning value: ${settings.reasoning}`);
    }
  if (
    !d.analysis.compare ||
    !["source", "configuration"].includes(d.analysis.compare.axis) ||
    d.analysis.eligibility !== "paired-correct"
  )
    throw new Error("Invalid comparison analysis settings.");
}
export function mergeSettings(shared, override) {
  const scopes = new Set([...Object.keys(shared), ...Object.keys(override)]);
  for (const scope of scopes)
    if (!["parent", "selfModification"].includes(scope))
      throw new Error(`Unsupported settings scope: ${scope}`);
  const resolved = {};
  for (const scope of scopes) {
    const fields = { ...shared[scope], ...override[scope] };
    if (Object.keys(fields).some((field) => !["model", "reasoning"].includes(field)))
      throw new Error(`Unsupported setting in ${scope}.`);
    resolved[scope] = fields;
  }
  return resolved;
}
async function resolveImportedModules(root, definitionFile, source) {
  const modules = [];
  const visited = new Set();
  async function visit(importer, contents) {
    const specs = [...contents.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)].map(
      (match) => match[1],
    );
    for (const specifier of specs) {
      const path = await realpath(resolve(dirname(importer), specifier));
      if (!path.startsWith(`${root}${sep}`))
        throw new Error("Imported experiment modules must remain inside the repository.");
      if (visited.has(path)) continue;
      visited.add(path);
      const bytes = await readFile(path);
      const relativePath = path
        .slice(root.length + 1)
        .split(sep)
        .join("/");
      const clean = await git(root, ["status", "--porcelain", "--", relativePath]);
      if (clean)
        throw new Error(`Imported experiment module must be committed and clean: ${relativePath}`);
      await git(root, ["cat-file", "-e", `HEAD:${relativePath}`]);
      modules.push({
        path: relativePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      await visit(path, bytes.toString("utf8"));
    }
  }
  await visit(definitionFile, source);
  return modules;
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
  return (await execFile("git", args, { cwd: root, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
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
  const [definition, output] = process.argv.slice(2);
  if (!definition || !output) throw new Error("Usage: node plan.mjs <experiment.mjs> <plan.json>");
  const plan = await createPlan(resolve(definition));
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`Planned ${plan.executions} eval executions.`);
}
