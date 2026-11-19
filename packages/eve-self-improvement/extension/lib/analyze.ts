import { digest } from "./config.js";
import { metricPriority } from "./gates.js";
import type { Evidence, Finding, Observation } from "./types.js";

const p95 = (values: number[]) => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
/** Ranks evidence-backed correction, failure, latency, and redundant-work findings, preserving missing-evidence boundaries. */
export function rankFindings(evidence: Evidence, baseline?: Evidence): Finding[] {
  if (!evidence.complete) return [];
  const findings: Finding[] = [];
  const observations = evidence.observations;
  const targets = new Set(
    observations.filter((o) => o.kind === "tool" || o.kind === "turn").map((o) => o.target),
  );
  for (const target of targets) {
    const calls = observations.filter(
      (o) => o.target === target && (o.kind === "tool" || o.kind === "turn"),
    );
    const turnKey = (o: Observation) => `${o.session}:${o.turn}`;
    const turns = new Set(calls.map(turnKey));
    const feedback = observations.filter(
      (o) =>
        o.kind === "feedback" &&
        o.feedback === "correction" &&
        (o.confidence ?? 0) >= 0.8 &&
        (o.target === target || target === "agent") &&
        turns.has(turnKey(o)),
    );
    const corrected = new Set(feedback.map(turnKey));
    const principals = new Set(feedback.map((o) => o.principal));
    const finding = (metric: Finding["metric"], count: number, summary: string): Finding => ({
      id: digest([target, metric]).slice(0, 24),
      target,
      metric,
      count,
      samples: calls.length,
      principals: principals.size,
      summary,
    });
    if (corrected.size >= 3 && principals.size >= 2)
      findings.push(
        finding(
          "correction",
          corrected.size,
          `${corrected.size}/${turns.size} distinct turns corrected across ${principals.size} principals`,
        ),
      );
    const failures = calls.filter((o) => o.outcome === "failed").length;
    if (failures >= 2)
      findings.push(
        finding("failure", failures, `${failures}/${calls.length} observed executions failed`),
      );

    if (corrected.size) {
      const priorCalls =
        baseline?.observations.filter(
          (o) => o.target === target && (o.kind === "tool" || o.kind === "turn"),
        ) ?? [];
      const priorTurns = new Set(priorCalls.map(turnKey));
      const priorCorrections = new Set(
        baseline?.observations
          .filter(
            (o) =>
              o.kind === "feedback" &&
              o.feedback === "correction" &&
              (o.confidence ?? 0) >= 0.8 &&
              priorTurns.has(turnKey(o)),
          )
          .map(turnKey),
      );
      if (
        !baseline?.complete ||
        !baseline.observationsComplete ||
        !priorTurns.size ||
        corrected.size / turns.size > priorCorrections.size / priorTurns.size
      )
        continue;
    }
    const durations = calls.flatMap((o) =>
      o.durationMs !== undefined && Number.isFinite(o.durationMs) && o.durationMs >= 0
        ? [o.durationMs]
        : [],
    );
    if (durations.length >= 5 && p95(durations) > 2000)
      findings.push(
        finding(
          "latency",
          durations.length,
          `p95 ${Math.round(p95(durations))}ms across ${durations.length} completed ${target === "agent" ? "turns" : "tool calls"}`,
        ),
      );
    const fingerprints = new Set<string>();
    let repeated = 0;
    for (const call of calls)
      if (call.fingerprint) {
        const key = `${turnKey(call)}:${call.fingerprint}`;
        if (fingerprints.has(key)) repeated++;
        else fingerprints.add(key);
      }
    if (repeated >= 2)
      findings.push(
        finding(
          "redundancy",
          repeated,
          `${repeated} repeated HMAC argument fingerprints within turns; verify that repetition was unnecessary`,
        ),
      );
  }
  const failedRuns = evidence.runs.filter((r) => !r.scheduled && r.status === "failed");
  if (failedRuns.length >= 2 && !findings.some((f) => f.metric === "failure"))
    findings.push({
      id: digest(["agent-runs", "failure"]).slice(0, 24),
      target: "agent",
      metric: "failure",
      count: failedRuns.length,
      samples: evidence.runs.filter((r) => !r.scheduled).length,
      principals: 0,
      summary: `${failedRuns.length} terminal failed runs; inspect a reproducible cause before changing code`,
    });
  return findings
    .sort((a, b) => metricPriority(b.metric) - metricPriority(a.metric) || b.count - a.count)
    .slice(0, 3);
}
/** Summarizes observed run counts and available provider pricing without inventing missing costs. */
export function summarizeUsage(evidence: Evidence) {
  const runs = evidence.runs.filter((r) => !r.scheduled);
  const priced = runs.filter((r) => r.usage?.costUsd !== undefined);
  return {
    runs: runs.length,
    pricedRuns: priced.length,
    reportedCostUsd: priced.length ? priced.reduce((sum, r) => sum + r.usage!.costUsd!, 0) : null,
  };
}
