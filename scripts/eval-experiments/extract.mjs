import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const METRIC_SCHEMA_VERSION = "self-modification-v1";
const TARGET_AGENT = "self-modification__agent";
const TERMINAL_FAILURES = new Set(["turn.failed", "turn.cancelled"]);

/** Normalize one per-eval artifact. Session arrays are authoritative; the top-level event stream is not merged. */
export function extractSample(input) {
  const sessions = input.artifact?.result?.sessions;
  const base = { ...input.identity, metricSchemaVersion: METRIC_SCHEMA_VERSION };
  if (!Array.isArray(sessions))
    return {
      ...base,
      verdict: input.verdict,
      measurement: { status: "incomplete", reason: "missing-session-capture" },
    };

  const eventsBySession = new Map();
  for (const session of sessions) {
    if (typeof session.sessionId !== "string" || !Array.isArray(session.events)) continue;
    const unique = new Map();
    for (const event of session.events) {
      const id = event?.meta?.id;
      const key = typeof id === "string" ? id : `unidentified:${unique.size}`;
      if (!unique.has(key)) unique.set(key, event);
    }
    eventsBySession.set(session.sessionId, [...unique.values()]);
  }

  const delegations = [];
  for (const [sessionId, events] of eventsBySession) {
    for (const event of events) {
      if (event?.type === "subagent.called" && event.data?.name === TARGET_AGENT) {
        delegations.push({ parentSessionId: sessionId, event });
      }
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
  const invocation = childEvents.find((event) => event.type === "session.started")?.data
    ?.invocation;
  if (
    !invocation ||
    invocation.kind !== "subagent" ||
    invocation.parentCallId !== callId ||
    invocation.parentSessionId !== parentSessionId ||
    invocation.parentTurnId !== parentTurnId
  )
    return incomplete(base, input, "child-invocation-mismatch");
  const parentEvents = eventsBySession.get(parentSessionId);
  const parentStart = parentEvents?.find(
    (event) => event.type === "turn.started" && event.data?.turnId === parentTurnId,
  );
  if (!parentStart) return incomplete(base, input, "missing-parent-turn-start");
  if (!parentStart.meta?.id) return incomplete(base, input, "missing-event-identity");

  const starts = childEvents.filter((event) => event.type === "turn.started");
  const failures = childEvents.filter(
    (event) => TERMINAL_FAILURES.has(event.type) || event.type === "session.failed",
  );
  if (failures.length) return incomplete(base, input, "child-turn-failed");
  const completions = childEvents.filter((event) => event.type === "turn.completed");
  if (starts.length !== 1 || completions.length !== 1)
    return incomplete(
      base,
      input,
      starts.length > 1 || completions.length > 1
        ? "ambiguous-child-turn"
        : "missing-child-turn-boundary",
    );
  const start = starts[0];
  const completed = completions[0];
  const turnId = start.data?.turnId;
  if (!turnId || completed.data?.turnId !== turnId)
    return incomplete(base, input, "child-turn-mismatch");
  if (!start.meta?.id || !completed.meta?.id)
    return incomplete(base, input, "missing-event-identity");
  if (
    childEvents.some((item) => item.type === "input.requested" && item.data?.turnId === turnId) ||
    completed.data?.status === "waiting" ||
    childEvents.some(
      (item) =>
        item.type === "session.waiting" &&
        Date.parse(item.meta?.at ?? "") <= Date.parse(completed.meta?.at ?? ""),
    )
  )
    return incomplete(base, input, "child-turn-parked");

  const parentAt = Date.parse(parentStart.meta?.at ?? "");
  const childStartAt = Date.parse(start.meta?.at ?? "");
  const childEndAt = Date.parse(completed.meta?.at ?? "");
  if (![parentAt, childStartAt, childEndAt].every(Number.isFinite))
    return incomplete(base, input, "missing-timestamp");
  const creationElapsedMs = childEndAt - parentAt;
  const childTurnMs = childEndAt - childStartAt;
  if (creationElapsedMs < 0 || childTurnMs < 0)
    return incomplete(base, input, "negative-elapsed-time");
  const toolCalls = new Set(
    childEvents
      .filter((item) => item.type === "actions.requested")
      .flatMap((item) =>
        (item.data?.actions ?? [])
          .filter((action) => action.kind === "tool-call")
          .map((action) => action.callId)
          .filter(Boolean),
      ),
  );
  return {
    ...base,
    verdict: resolveVerdict(input),
    observedModelSettings: {
      parent: [...(eventsBySession.get(parentSessionId) ?? [])]
        .filter((event) => event.type === "step.started")
        .map((event) => event.data?.modelId)
        .filter(Boolean),
      child: childEvents
        .filter((event) => event.type === "step.started")
        .map((event) => event.data?.modelId)
        .filter(Boolean),
    },
    measurement: { status: "complete" },
    metrics: { creationElapsedMs, childTurnMs, childToolCalls: toolCalls.size },
    events: {
      parentStart: ref(parentStart),
      childStart: ref(start),
      childCompletion: ref(completed),
      delegation: ref(called),
      childSessionId,
      parentSessionId,
      callId,
    },
  };
}

function ref(event) {
  return { id: event.meta?.id, at: event.meta?.at, type: event.type };
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
    samples.push(
      extractSample({
        identity: { ...identities, ...invocation, eval: artifact.id, artifact: path },
        artifact,
        verdict: artifact.verdict,
      }),
    );
  }
  for (const path of await findInvocationFiles(resolve(root))) {
    const invocation = JSON.parse(await readFile(path, "utf8"));
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
        metricSchemaVersion: METRIC_SCHEMA_VERSION,
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
