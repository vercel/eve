import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getProfile } from "./profiles/index.mjs";

export function extractSample(input) {
  const sessions = input.artifact?.result?.sessions;
  const profile = input.profile ?? getProfile(input.identity.metricProfile);
  if (input.artifact?.id && input.identity?.eval && input.artifact.id !== input.identity.eval)
    throw new Error(
      `Artifact eval ${input.artifact.id} does not match requested eval ${input.identity.eval}.`,
    );
  const base = {
    ...input.identity,
    metricProfile: profile.id,
    metricSchemaVersion: profile.metricSchemaVersion,
  };
  if (!Array.isArray(sessions)) return incomplete(base, input, "missing-session-capture");

  const eventsBySession = indexSessionEvents(sessions);
  const delegations = [];
  for (const [sessionId, events] of eventsBySession) {
    for (const event of events) {
      if (event.type === "subagent.called" && event.data?.name === profile.targetAgent)
        delegations.push({ parentSessionId: sessionId, event });
    }
  }
  if (delegations.length !== 1)
    return incomplete(
      base,
      input,
      delegations.length ? "ambiguous-delegation" : "missing-delegation",
    );

  const { parentSessionId, event: called } = delegations[0];
  const { childSessionId, turnId: parentTurnId, callId } = called.data ?? {};
  if (!called.meta?.id) return incomplete(base, input, "missing-event-identity");
  if (
    typeof childSessionId !== "string" ||
    typeof parentTurnId !== "string" ||
    typeof callId !== "string"
  )
    return incomplete(base, input, "missing-delegation-identities");
  if (childSessionId === parentSessionId) return incomplete(base, input, "child-session-reused");
  const childEvents = eventsBySession.get(childSessionId);
  if (!childEvents) return incomplete(base, input, "missing-child-capture");

  const measurement = profile.extractMeasurement({
    sessions,
    eventsBySession,
    parentSessionId,
    parentTurnId,
    called,
    childSessionId,
    childEvents,
  });
  if (measurement.status !== "complete") return incomplete(base, input, measurement.reason);
  return {
    ...base,
    verdict: resolveVerdict(input),
    measurement: { status: "complete" },
    metrics: measurement.metrics,
    observedModelSettings: measurement.observedModelSettings,
    events: measurement.events,
  };
}

function indexSessionEvents(sessions) {
  const result = new Map();
  for (const session of sessions) {
    if (typeof session.sessionId !== "string" || !Array.isArray(session.events)) continue;
    const unique = new Map();
    for (const event of session.events) {
      const key =
        typeof event?.meta?.id === "string" ? event.meta.id : `unidentified:${unique.size}`;
      if (!unique.has(key)) unique.set(key, event);
    }
    result.set(session.sessionId, [...unique.values()]);
  }
  return result;
}

function incomplete(base, input, reason) {
  return {
    ...base,
    verdict: resolveVerdict(input),
    measurement: { status: "incomplete", reason },
  };
}
function resolveVerdict(input) {
  if (input.identity?.infrastructureError) return "unknown";
  if (input.identity?.correctnessOutcome === "failed") return "failed";
  return input.verdict;
}

export async function extractDirectory(root, identities = {}) {
  const files = await findArtifacts(resolve(root));
  const samples = [];
  for (const path of files) {
    const artifact = JSON.parse(await readFile(path, "utf8"));
    if (!artifact?.result?.sessions) continue;
    const invocation = await findInvocation(dirname(dirname(path)));
    const identity = { ...identities, ...invocation, eval: artifact.id, artifact: path };
    if (!identity.metricProfile) throw new Error(`Invocation is missing a metric profile: ${path}`);
    if (
      identities.metricProfile &&
      invocation.metricProfile &&
      identities.metricProfile !== invocation.metricProfile
    )
      throw new Error(
        `Invocation metric profile ${invocation.metricProfile} does not match requested profile ${identities.metricProfile}.`,
      );
    const profile = getProfile(identity.metricProfile);
    samples.push(extractSample({ identity, artifact, verdict: artifact.verdict, profile }));
  }
  for (const path of await findInvocationFiles(resolve(root))) {
    const invocation = JSON.parse(await readFile(path, "utf8"));
    if (!invocation.metricProfile)
      throw new Error(`Invocation is missing a metric profile: ${path}`);
    for (const evalId of invocation.selectedEvals ?? []) {
      if (
        samples.some(
          (sample) =>
            sample.variant === invocation.variant &&
            sample.fixture === invocation.fixture &&
            sample.eval === evalId &&
            sample.model === invocation.model &&
            sample.repetition === invocation.repetition,
        )
      )
        continue;
      const profile = getProfile(invocation.metricProfile);
      samples.push({
        ...identities,
        ...invocation,
        eval: evalId,
        verdict:
          invocation.correctnessOutcome === "passed"
            ? "passed"
            : invocation.correctnessOutcome === "failed"
              ? "failed"
              : "missing",
        infrastructureError: invocation.infrastructureError,
        artifact: invocation.artifact,
        metricProfile: profile.id,
        metricSchemaVersion: profile.metricSchemaVersion,
        measurement: {
          status: "incomplete",
          reason: invocation.infrastructureError
            ? "invocation-infrastructure-error"
            : "missing-eval-artifact",
        },
      });
    }
  }
  return samples;
}

async function findInvocation(start) {
  let current = start;
  for (let depth = 0; depth < 8; depth++) {
    try {
      return JSON.parse(await readFile(join(current, "invocation.json"), "utf8"));
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
  const found = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === "invocation.json") found.push(path);
      if (found.length > 10_000) throw new Error("Invocation limit exceeded (10000 files).");
    }
  }
  await visit(root).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return found;
}

async function findArtifacts(root) {
  const found = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".json") && entry.name !== "summary.json") found.push(path);
      if (found.length > 10_000) throw new Error("Artifact limit exceeded (10000 files).");
    }
  }
  await visit(root).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [inputDir, outputPath, identityJson = "{}"] = process.argv.slice(2);
  if (!inputDir || !outputPath)
    throw new Error("Usage: node extract.mjs <artifact-dir> <output.json> [identity-json]");
  const samples = await extractDirectory(inputDir, JSON.parse(identityJson));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outputPath, `${JSON.stringify(samples, null, 2)}\n`);
}
