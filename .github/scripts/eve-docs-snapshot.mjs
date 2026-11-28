// Turns one or more eve-bench report.json files into the public eve benchmark results snapshot
// rendered by the docs site. Keeps only aggregate scores, per-task summaries, overhead, and public
// run links: the result store is private, so blob URLs and per-trial artifacts never reach the docs.
import { readFile, writeFile } from "node:fs/promises";

export const SNAPSHOT_SCHEMA_VERSION = 2;

const TOP_TOOL_LIMIT = 6;

/** Derives a stable model family key (such as "anthropic" or "openai") from a model ID. */
export function modelFamily(modelId) {
  if (typeof modelId !== "string" || modelId.trim() === "") return "unknown";
  const prefix = modelId.trim().split("/")[0]?.toLowerCase() ?? "unknown";
  return prefix || "unknown";
}

/** Returns the dataset model entry for a report, or a reason why it must not be published. */
export function snapshotFromReport(report) {
  if (report.status !== "comparable" && report.status !== "measured") {
    return { skip: `report status is ${report.status}` };
  }
  const manifest = report.manifest;
  if (manifest.task !== null || manifest.cohort !== null) return { skip: "not a full-dataset run" };
  const comparison = report.comparison?.comparison;
  if (!comparison?.compatible || !comparison.complete || !comparison.summary) {
    return { skip: "report has no complete cross-harness comparison" };
  }
  const results = new Map(
    comparison.results.map((result) => [result.contender ?? result.harness, result]),
  );
  const eveResult = comparison.results.find((result) => result.harness === "eve");
  if (!eveResult) {
    return { skip: "report has no eve result" };
  }

  const publishedAt = new Map(
    (report.comparison.references ?? []).map((reference) => [
      reference.harness,
      reference.entry.publishedAt,
    ]),
  );
  const finishedAt = (result) =>
    result.trials
      .map((trial) => trial.finishedAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

  const contenders =
    comparison.summary.contenders ?? comparison.summary.scores.map((s) => s.contender);
  const contenderToHarness = new Map(
    contenders.map((contender) => {
      const result = results.get(contender);
      return [contender, result?.harness === "eve" ? "eve" : contender];
    }),
  );

  const summaryTasks = Array.isArray(comparison.summary.tasks) ? comparison.summary.tasks : [];
  const passAllCounts = new Map();
  for (const contender of contenders) {
    passAllCounts.set(contender, { passed: 0, total: 0 });
  }

  const tasks = summaryTasks.map((taskRow) => {
    const cells = {};
    contenders.forEach((contender, index) => {
      const cell = taskRow.cells?.[index];
      if (!cell) return;
      const harnessName = contenderToHarness.get(contender) ?? contender;
      const tracker = passAllCounts.get(contender);
      if (tracker && cell.attempts > 0) {
        tracker.total += 1;
        if (cell.resolved === cell.attempts) tracker.passed += 1;
      }
      cells[harnessName] = {
        resolved: cell.resolved,
        attempts: cell.attempts,
        latencyMs: typeof cell.latencyMs === "number" ? Math.round(cell.latencyMs) : null,
        inputTokens: typeof cell.inputTokens === "number" ? Math.round(cell.inputTokens) : null,
        outputTokens: typeof cell.outputTokens === "number" ? Math.round(cell.outputTokens) : null,
        costUsd: typeof cell.costUsd === "number" ? cell.costUsd : null,
      };
    });
    return { task: taskRow.task, cells };
  });

  const effectsByContender = new Map();
  for (const effect of comparison.summary.effects ?? []) {
    if (!effect?.contender || !effect?.metric) continue;
    const map = effectsByContender.get(effect.contender) ?? {};
    map[effect.metric] = {
      better: effect.better ?? 0,
      worse: effect.worse ?? 0,
      estimate: effect.effect?.estimate ?? null,
      low: effect.effect?.low ?? null,
      high: effect.effect?.high ?? null,
      verdict: effect.verdict ?? "inconclusive",
    };
    effectsByContender.set(effect.contender, map);
  }

  const model = manifest.modelVersion ?? { id: manifest.model };
  const family = modelFamily(model.id ?? manifest.model);
  const reasoning =
    eveResult.provenance?.harnessSettings?.reasoning ??
    eveResult.provenance?.harness?.reasoning ??
    null;

  return {
    section: {
      dataset: {
        name: manifest.dataset.name,
        version: manifest.dataset.version,
        ...(manifest.dataset.commit ? { commit: manifest.dataset.commit } : {}),
      },
      family,
      model,
      attempts: manifest.attempts,
      tasks: manifest.tasks.length,
      reasoning,
      runUrl: eveResult.provenance?.run?.url ?? null,
      harnesses: comparison.summary.scores.map((score) => {
        const result = results.get(score.contender);
        if (!result) throw new Error(`No result for contender ${score.contender}.`);
        const harnessName = result.harness === "eve" ? "eve" : score.contender;
        const passAll = passAllCounts.get(score.contender);
        const passAllTasks = passAll && passAll.total > 0 ? passAll.passed : null;
        const passAllRate = passAll && passAll.total > 0 ? passAll.passed / passAll.total : null;
        const rawOverhead = report.overhead?.[result.harness] ?? report.overhead?.[score.contender];

        return {
          harness: harnessName,
          version: harnessVersion(result.harness, result.provenance),
          resolved: score.resolved,
          attempts: score.attempts,
          resolveRate: score.resolveRate,
          passAllTasks,
          passAllRate,
          costUsd: score.costUsd ?? null,
          medianCostUsd: score.medianCostUsd ?? null,
          costPerResolvedUsd: score.costPerResolvedUsd ?? null,
          inputTokens: score.inputTokens,
          outputTokens: score.outputTokens,
          cachedShare: score.cachedShare ?? null,
          latencyP50Ms: score.latencyP50Ms,
          latencyP90Ms: score.latencyP90Ms,
          overhead: extractOverhead(rawOverhead),
          effectsVsEve:
            harnessName === "eve" ? null : (effectsByContender.get(score.contender) ?? null),
          source: result.provenance.source?.revision ?? null,
          runUrl: result.provenance.run?.url ?? null,
          measuredAt:
            publishedAt.get(result.harness) ??
            publishedAt.get(score.contender) ??
            finishedAt(result),
        };
      }),
      taskMatrix: tasks,
    },
  };
}

function extractOverhead(raw) {
  if (!raw || typeof raw !== "object") return null;
  const byTool = raw.toolCalls?.byTool;
  const topTools =
    byTool && typeof byTool === "object"
      ? Object.entries(byTool)
          .filter(([, count]) => typeof count === "number" && count > 0)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, TOP_TOOL_LIMIT)
          .map(([name, count]) => ({ name, count }))
      : [];
  return {
    firstStepInputTokens: raw.firstStepInputTokens?.median ?? null,
    modelStepsMedian: raw.modelSteps?.median ?? null,
    modelStepsTotal: raw.modelSteps?.total ?? null,
    toolCallsMedian: raw.toolCalls?.median ?? null,
    toolCallsTotal: raw.toolCalls?.total ?? null,
    topTools,
  };
}

/** A released harness reports its package version; eve is identified by its source commit. */
function harnessVersion(harness, provenance) {
  const settings = provenance.harness ?? {};
  const harnessSettings = provenance.harnessSettings ?? {};
  if (harness === "eve") {
    const sha = settings.source?.gitSha ?? provenance.source?.revision;
    if (typeof sha === "string") return sha.slice(0, 7);
  }
  const version = harnessSettings.version ?? settings.version ?? settings[`${harness}Version`];
  if (typeof version === "string") return version;
  const sha = settings.source?.gitSha ?? provenance.source?.revision;
  return typeof sha === "string" ? sha.slice(0, 7) : null;
}

/**
 * Replaces one dataset's model entry in an existing snapshot (upgrading v1 snapshots in place).
 * Unchanged model results keep their generatedAt, so rerunning the same report leaves the file
 * byte-identical and commits nothing.
 */
export function mergeSnapshot(existing, section, generatedAt) {
  const normalizedDatasets = normalizeExistingDatasets(existing);
  const datasetName = section.dataset.name;
  const existingDataset = normalizedDatasets[datasetName] ?? {};
  const existingModels = existingDataset.models ?? {};

  const { dataset, family, attempts, tasks, reasoning, ...modelPayload } = section;

  const nextModelBody = { family, ...modelPayload };
  const { generatedAt: previousAt, ...previousModel } = existingModels[family] ?? {};
  const unchanged = previousAt && JSON.stringify(previousModel) === JSON.stringify(nextModelBody);

  const nextModels = {
    ...existingModels,
    [family]: {
      ...nextModelBody,
      generatedAt: unchanged ? previousAt : generatedAt,
    },
  };

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    datasets: {
      ...normalizedDatasets,
      [datasetName]: {
        dataset,
        attempts,
        tasks,
        reasoning,
        models: nextModels,
      },
    },
  };
}

function normalizeExistingDatasets(existing) {
  const raw = existing?.datasets;
  if (!raw || typeof raw !== "object") return {};
  const normalized = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.models && typeof entry.models === "object") {
      normalized[name] = entry;
      continue;
    }
    if (entry.model && Array.isArray(entry.harnesses)) {
      const family = modelFamily(entry.model.id);
      normalized[name] = {
        dataset: entry.dataset,
        attempts: entry.attempts,
        tasks: entry.tasks,
        reasoning: entry.reasoning ?? null,
        models: {
          [family]: {
            family,
            model: entry.model,
            runUrl:
              entry.harnesses.find((h) => h.harness === "eve" || h.harness === "eve-code")
                ?.runUrl ?? null,
            harnesses: entry.harnesses,
            taskMatrix: [],
            generatedAt: entry.generatedAt,
          },
        },
      };
    } else {
      normalized[name] = entry;
    }
  }
  return normalized;
}

/** GraphQL body for a GitHub-signed commit of the snapshot onto `branch` at `expectedHeadOid`. */
export function commitPayload({ repository, branch, expectedHeadOid, path, contents, runUrl }) {
  return {
    query:
      "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { url } } }",
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: branch },
        expectedHeadOid,
        message: {
          headline: "chore: refresh eve benchmark results",
          body: `From ${runUrl}\n\nSigned-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`,
        },
        fileChanges: { additions: [{ path, contents: Buffer.from(contents).toString("base64") }] },
      },
    },
  };
}

async function main(args) {
  if (args[0] === "--commit-payload") {
    const path = args[1];
    const env = process.env;
    const payload = commitPayload({
      repository: env.GITHUB_REPOSITORY,
      branch: env.BRANCH,
      expectedHeadOid: env.HEAD_OID,
      path,
      contents: await readFile(path),
      runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    });
    process.stdout.write(JSON.stringify(payload));
    return;
  }
  if (args.length < 2) {
    throw new Error("Usage: eve-docs-snapshot.mjs <report.json> [...report.json] <snapshot.json>");
  }
  const snapshotPath = args.at(-1);
  const reportPaths = args.slice(0, -1);
  let snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const generatedAt = new Date().toISOString();
  const updated = [];

  for (const reportPath of reportPaths) {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const { skip, section } = snapshotFromReport(report);
    if (skip) {
      console.log(`::notice::eve docs snapshot skipped ${reportPath}: ${skip}.`);
      continue;
    }
    snapshot = mergeSnapshot(snapshot, section, generatedAt);
    updated.push(`${section.dataset.name}/${section.family}`);
  }

  if (updated.length === 0) return;
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Updated ${updated.join(", ")} in ${snapshotPath}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
