export const MAX_EVAL_OUTPUT_BYTES = 32 * 1024 * 1024;

export function validateEvalIds(ids, { required = true } = {}) {
  if (
    !Array.isArray(ids) ||
    (required && ids.length === 0) ||
    ids.length > 64 ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) =>
        typeof id !== "string" ||
        id.length > 256 ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(id) ||
        id.split("/").some((part) => part === "" || part === "." || part === ".."),
    )
  ) {
    throw new Error("Provide 1 to 64 distinct plain eval IDs (no CLI options or traversal).");
  }
}

export function parseEvalSummary(stdout, expectedEvalIds) {
  validateEvalIds(expectedEvalIds);
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_EVAL_OUTPUT_BYTES) {
    return { passed: false, issues: ["Missing or oversized CLI JSON."], evals: [] };
  }
  let summary;
  try {
    summary = JSON.parse(stdout);
  } catch {
    return { passed: false, issues: ["The eval process did not produce valid JSON."], evals: [] };
  }
  return { summary, ...inspectEvalSummary(summary, expectedEvalIds) };
}

export function isCleanEvalSummary(summary, expectedEvalIds) {
  return inspectEvalSummary(summary, expectedEvalIds).passed;
}

function inspectEvalSummary(summary, expectedEvalIds) {
  validateEvalIds(expectedEvalIds);
  const issues = [];
  if (!isRecord(summary) || !Array.isArray(summary.results)) {
    return { passed: false, issues: ["CLI summary must contain a results array."], evals: [] };
  }
  if (summary.results.length === 0 || summary.results.length > 64) {
    return { passed: false, issues: ["Expected 1 to 64 eval results."], evals: [] };
  }

  const counts = { passed: 0, failed: 0, scored: 0, skipped: 0, errored: 0 };
  const seen = new Set();
  const expected = new Set(expectedEvalIds);
  const evals = [];
  for (const result of summary.results) {
    if (!isRecord(result) || typeof result.id !== "string") {
      issues.push("Malformed eval result or missing ID.");
      continue;
    }
    const { id, verdict } = result;
    if (seen.has(id)) issues.push(`Duplicate eval ID: ${id}`);
    seen.add(id);
    if (!expected.has(id)) issues.push(`Unexpected eval ID: ${id}`);
    if (["passed", "failed", "scored", "skipped"].includes(verdict)) counts[verdict] += 1;
    if (verdict !== "passed") issues.push(`${id}: verdict is ${String(verdict)}`);
    if (result.error !== undefined) {
      counts.errored += 1;
      issues.push(`${id}: execution error is present`);
    }
    if (result.skipReason !== undefined) issues.push(`${id}: skip reason is present`);
    const softMetrics = [];
    if (
      !Array.isArray(result.assertions) ||
      result.assertions.some(
        (assertion) =>
          !isRecord(assertion) ||
          typeof assertion.name !== "string" ||
          !Number.isFinite(assertion.score) ||
          !["gate", "soft"].includes(assertion.severity) ||
          typeof assertion.passed !== "boolean",
      )
    ) {
      issues.push(`${id}: missing or malformed assertions`);
    } else {
      for (const assertion of result.assertions) {
        if (assertion.severity === "gate" && !assertion.passed) {
          issues.push(`${id}: required gate failed: ${String(assertion.name)}`);
        } else if (assertion.severity === "soft") {
          softMetrics.push({
            name: assertion.name,
            score: assertion.score,
            threshold: assertion.threshold,
            passed: assertion.passed,
          });
        }
      }
    }
    const events = result.result?.events;
    const validEvents =
      Array.isArray(events) &&
      events.every((event) => isRecord(event) && typeof event.type === "string");
    if (!validEvents) issues.push(`${id}: missing or malformed event log`);
    const compaction = validEvents ? compactionCounts(events) : null;
    evals.push({
      id,
      verdict,
      error: result.error === undefined ? undefined : String(result.error).slice(0, 2_000),
      compaction,
      softMetrics,
    });
  }
  for (const id of expected) {
    if (!seen.has(id)) issues.push(`Missing expected eval ID: ${id}`);
  }
  for (const [name, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(summary[name]) || summary[name] !== count) {
      issues.push(`Summary ${name} count does not match the results.`);
    }
  }
  return { passed: issues.length === 0, issues, evals };
}

function compactionCounts(events) {
  let requested = 0;
  let completed = 0;
  const modelIds = new Set();
  // result.events already aggregates sessions; adding session.events would double-count.
  for (const event of events) {
    if (event.type === "compaction.requested") requested += 1;
    else if (event.type === "compaction.completed") completed += 1;
    else continue;
    if (typeof event.data?.modelId === "string") modelIds.add(event.data.modelId);
  }
  return {
    requested,
    completed,
    uncompletedRequests: Math.max(0, requested - completed),
    modelIds: [...modelIds].sort(),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Exact one-sided binomial bound, conditional on independent, stationary trials.
export function zeroFailureUpperBound95(runs) {
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error("A confidence bound requires a positive integer trial count.");
  }
  return -Math.expm1(Math.log(0.05) / runs);
}

export { zeroFailureUpperBound95 as zeroFailureUpperBound };
