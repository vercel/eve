import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export function validateCapturedArtifact(value, expectedEval) {
  if (!record(value) || typeof value.id !== "string" || value.id !== expectedEval)
    throw new Error(`Unsupported eval artifact identity; expected ${expectedEval}.`);
  if (!record(value.result) || !["completed", "failed", "waiting"].includes(value.result.status))
    throw new Error(`Unsupported task result shape for ${expectedEval}.`);
  if (value.result.sessions !== undefined && !Array.isArray(value.result.sessions))
    throw new Error(`Unsupported session captures for ${expectedEval}.`);
  for (const session of value.result.sessions ?? []) {
    if (!record(session) || typeof session.sessionId !== "string" || !Array.isArray(session.events))
      throw new Error(`Unsupported session capture in ${expectedEval}.`);
  }
  return {
    id: value.id,
    verdict: value.verdict,
    assertions: value.assertions,
    error: value.error,
    skipReason: value.skipReason,
    result: {
      sessions: value.result.sessions,
      derived: value.result.derived,
      status: value.result.status,
    },
  };
}

export function validateMeasurements(bundle, captured) {
  const result = bundle.derive(captured);
  if (!record(result)) throw new Error("Measurement derive() must return an object.");
  const declared = Object.keys(bundle.metrics).sort();
  const returned = Object.keys(result).sort();
  if (JSON.stringify(declared) !== JSON.stringify(returned))
    throw new Error("Measurement keys do not match declared metric keys.");
  for (const [name, measurement] of Object.entries(result)) {
    if (
      !record(measurement) ||
      !["measured", "unavailable", "not-applicable"].includes(measurement.status)
    )
      throw new Error(`Invalid measurement status for ${name}.`);
    if (measurement.status === "measured" && !Number.isFinite(measurement.value))
      throw new Error(`Invalid numeric measurement for ${name}.`);
    if (measurement.status !== "measured" && typeof measurement.reason !== "string")
      throw new Error(`Missing measurement reason for ${name}.`);
  }
  return result;
}

export async function extractDirectory(root, plan, options = {}) {
  const base = resolve(root);
  const definitionPath = resolve(
    options.definitionPath ?? join(process.cwd(), plan.definitionPath),
  );
  const definition = (await import(pathToFileURL(definitionPath).href)).default;
  const bundles = definition.measurements;
  const artifactFiles = await findArtifacts(base);
  const invocations = await findInvocationFiles(base);
  const byIdentity = new Map();
  const analysisErrors = [];
  for (const file of invocations) {
    const invocation = await readJson(file);
    for (const evalId of invocation.selectedEvals ?? []) {
      const artifactPath = invocation.artifact
        ? resolve(base, invocation.artifact, "evals", `${safe(evalId)}.json`)
        : undefined;
      const identity = invocation;
      const key = sampleKey(identity, evalId);
      if (byIdentity.has(key)) {
        analysisErrors.push({ path: file, error: "duplicate-invocation" });
        continue;
      }
      byIdentity.set(key, { identity, evalId, artifactPath, invocationPath: file });
    }
  }
  for (const file of artifactFiles) {
    const artifact = await readJson(file);
    if (typeof artifact?.id !== "string") continue;
    const invocation = await findInvocation(dirname(dirname(file)));
    const identity = invocation;
    const key = sampleKey(identity, artifact.id);
    const previous = byIdentity.get(key);
    if (!previous) {
      analysisErrors.push({ path: file, error: "artifact-without-planned-invocation" });
      continue;
    }
    previous.artifactPath = file;
  }

  const samples = [];
  for (const cell of plan.schedule) {
    const identity = {
      planHash: plan.planHash,
      experimentRevision: plan.experimentRevision,
      source: cell.source,
      sourceSha: plan.sources.find((item) => item.label === cell.source)?.sha,
      configuration: cell.configuration,
      settings: plan.configurations.find((item) => item.label === cell.configuration)?.settings,
      fixture: cell.fixture,
      eval: cell.eval,
      repetition: cell.repetition,
      executionOrder: cell.executionOrder,
    };
    const key = sampleKey(identity, cell.eval);
    const found =
      byIdentity.get(key) ??
      [...byIdentity.values()].find(
        (item) =>
          item.identity?.source === cell.source &&
          item.identity?.configuration === cell.configuration &&
          item.identity?.fixture === cell.fixture &&
          item.evalId === cell.eval &&
          item.identity?.repetition === cell.repetition,
      );
    if (!found) {
      samples.push({
        ...identity,
        execution: { status: "missing" },
        verdict: "missing",
        measurements: {},
      });
      continue;
    }
    const inv = found.identity;
    const mismatch = validateProvenance(identity, inv);
    if (mismatch) {
      analysisErrors.push({ eval: cell.eval, error: mismatch });
      samples.push({
        ...identity,
        execution: { status: "error", error: mismatch },
        verdict: "unknown",
        measurements: {},
      });
      continue;
    }
    if (!found.artifactPath) {
      samples.push({
        ...identity,
        execution: {
          status: inv.infrastructureError ? "error" : "missing",
          error: inv.infrastructureError ?? "missing-eval-artifact",
        },
        verdict: inv.correctnessOutcome === "failed" ? "failed" : "missing",
        measurements: {},
      });
      continue;
    }
    let captured;
    try {
      captured = validateCapturedArtifact(await readJson(found.artifactPath), cell.eval);
    } catch (error) {
      analysisErrors.push({ eval: cell.eval, path: found.artifactPath, error: error.message });
      samples.push({
        ...identity,
        execution: {
          status: inv.infrastructureError ? "error" : "complete",
          error: inv.infrastructureError,
        },
        verdict: inv.correctnessOutcome === "failed" ? "failed" : "unknown",
        measurements: {},
      });
      continue;
    }
    const measurements = {};
    for (const [namespace, bundle] of Object.entries(bundles)) {
      try {
        const values = validateMeasurements(bundle, captured);
        for (const [name, measurement] of Object.entries(values))
          measurements[`${namespace}.${name}`] = measurement;
      } catch (error) {
        analysisErrors.push({ eval: cell.eval, namespace, error: error.message });
      }
    }
    if (mismatch) analysisErrors.push({ eval: cell.eval, error: mismatch });
    samples.push({
      ...identity,
      execution: {
        status: inv.infrastructureError ? "error" : "complete",
        error: inv.infrastructureError,
      },
      verdict:
        captured.verdict ??
        (inv.correctnessOutcome === "passed"
          ? "passed"
          : inv.correctnessOutcome === "failed"
            ? "failed"
            : "unknown"),
      runtimeObservedModels: observedModels(captured),
      measurements,
      artifact: found.artifactPath,
      invocation: found.invocationPath,
    });
  }
  return {
    version: 2,
    planHash: plan.planHash,
    analysisRevision: options.analysisRevision ?? plan.implementationRevision,
    measurementVersions: Object.fromEntries(
      Object.entries(bundles).map(([name, bundle]) => [name, bundle.version]),
    ),
    metricMetadata: Object.fromEntries(
      Object.entries(bundles).map(([namespace, bundle]) => [namespace, bundle.metrics]),
    ),
    samples,
    analysisErrors,
  };
}
function validateProvenance(expected, actual) {
  for (const key of [
    "planHash",
    "experimentRevision",
    "source",
    "sourceSha",
    "configuration",
    "fixture",
    "eval",
    "repetition",
    "executionOrder",
  ]) {
    if (actual?.[key] !== expected[key]) return `provenance-mismatch:${key}`;
  }
  if (JSON.stringify(actual.settings) !== JSON.stringify(expected.settings))
    return "provenance-mismatch:settings";
}
function observedModels(captured) {
  const result = { parent: [], selfModification: [] };
  const childSessions = new Set();
  for (const session of captured.result.sessions ?? [])
    for (const event of session.events ?? [])
      if (
        event.type === "subagent.called" &&
        event.data?.name === "self-modification__agent" &&
        typeof event.data.childSessionId === "string"
      )
        childSessions.add(event.data.childSessionId);
  for (const session of captured.result.sessions ?? [])
    for (const event of session.events ?? []) {
      if (event.type !== "step.started" || typeof event.data?.modelId !== "string") continue;
      const role = childSessions.has(session.sessionId) ? "selfModification" : "parent";
      result[role].push(event.data.modelId);
    }
  return result;
}
function sampleKey(identity, evalId) {
  return [
    identity?.source,
    identity?.configuration,
    identity?.fixture,
    evalId,
    identity?.repetition,
  ].join("\0");
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safe(value) {
  return String(value).replace(/[^a-zA-Z0-9._/-]/g, "_");
}
async function readJson(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES)
    throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes.`);
  return JSON.parse(bytes.toString("utf8"));
}
async function findInvocation(start) {
  let current = start;
  for (let i = 0; i < 8; i++) {
    try {
      return await readJson(join(current, "invocation.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {};
}
async function findInvocationFiles(root) {
  return findFiles(root, (name) => name === "invocation.json", 10_000);
}
async function findArtifacts(root) {
  return findFiles(
    root,
    (name) => name.endsWith(".json") && name !== "summary.json" && name !== "invocation.json",
    10_000,
  );
}
async function findFiles(root, predicate, limit) {
  const found = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (predicate(entry.name)) found.push(path);
      if (found.length > limit) throw new Error(`File limit exceeded (${limit}).`);
    }
  }
  await visit(root).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputDir, planPath, outputPath, definitionPath] = process.argv.slice(2);
  if (!inputDir || !planPath || !outputPath)
    throw new Error(
      "Usage: node extract.mjs <artifact-dir> <plan.json> <samples.json> [definition.mjs]",
    );
  const plan = await readJson(planPath);
  const [analysisRevision] = process.argv.slice(5);
  const result = await extractDirectory(inputDir, plan, { definitionPath, analysisRevision });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  if (result.analysisErrors.length) process.exitCode = 1;
}
