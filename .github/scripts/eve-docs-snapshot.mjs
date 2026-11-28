// Turns one or more eve-bench report.json files into the public eve benchmark results snapshot
// rendered by the docs site. Keeps only aggregate scores, per-task summaries, overhead, and public
// run links: the result store is private, so blob URLs and per-trial artifacts never reach the docs.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const SNAPSHOT_SCHEMA_VERSION = 2;

const TOP_TOOL_LIMIT = 6;

/** Derives a stable model family key (such as "anthropic" or "openai") from a model ID. */
export function modelFamily(modelId) {
  if (typeof modelId !== "string" || modelId.trim() === "") return "unknown";
  const prefix = modelId.trim().split("/")[0]?.toLowerCase() ?? "unknown";
  return prefix || "unknown";
}

function pickModelInfo(manifest) {
  const raw = manifest.modelVersion;
  const id = typeof raw?.id === "string" && raw.id.length > 0 ? raw.id : manifest.model;
  return {
    id,
    ...(typeof raw?.released === "string" ? { released: raw.released } : {}),
    ...(typeof raw?.knowledge === "string" ? { knowledge: raw.knowledge } : {}),
  };
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

  const eveContender = eveResult.contender ?? eveResult.harness;
  const baselineIsEve =
    comparison.summary.baseline === undefined || comparison.summary.baseline === eveContender;

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

  const taskMatrix = summaryTasks.map((taskRow) => {
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
      };
    });
    return { task: taskRow.task, cells };
  });

  const effectsByContender = new Map();
  if (baselineIsEve) {
    for (const effect of comparison.summary.effects ?? []) {
      if (!effect?.contender || !effect?.metric) continue;
      const map = effectsByContender.get(effect.contender) ?? {};
      map[effect.metric] = {
        better: effect.better ?? 0,
        worse: effect.worse ?? 0,
        verdict: effect.verdict ?? "inconclusive",
      };
      effectsByContender.set(effect.contender, map);
    }
  }

  const model = pickModelInfo(manifest);
  const family = modelFamily(model.id);
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
      taskMatrix,
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
    toolCallsMedian: raw.toolCalls?.median ?? null,
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
 * Replaces one model family entry in an existing snapshot (upgrading v1 snapshots in place).
 * Metadata (dataset version/commit, attempts, tasks, reasoning) is stored per model entry so
 * refreshing one model family never overwrites untouched siblings. Unchanged model entries keep
 * their generatedAt, leaving reruns byte-identical.
 */
export function mergeSnapshot(existing, section, generatedAt) {
  const normalizedDatasets = normalizeExistingDatasets(existing);
  const datasetName = section.dataset.name;
  const existingModels = normalizedDatasets[datasetName]?.models ?? {};

  const { generatedAt: previousAt, ...previousModel } = existingModels[section.family] ?? {};
  const unchanged = previousAt && JSON.stringify(previousModel) === JSON.stringify(section);

  const nextModels = {
    ...existingModels,
    [section.family]: {
      ...section,
      generatedAt: unchanged ? previousAt : generatedAt,
    },
  };

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    datasets: {
      ...normalizedDatasets,
      [datasetName]: {
        models: nextModels,
      },
    },
  };
}

function normalizeV1Harness(harness) {
  return {
    ...harness,
    passAllTasks: harness.passAllTasks ?? null,
    passAllRate: harness.passAllRate ?? null,
    costUsd: harness.costUsd ?? null,
    costPerResolvedUsd: harness.costPerResolvedUsd ?? null,
    cachedShare: harness.cachedShare ?? null,
    overhead: harness.overhead ?? null,
    effectsVsEve: harness.effectsVsEve ?? null,
  };
}

function normalizeExistingDatasets(existing) {
  const raw = existing?.datasets;
  if (!raw || typeof raw !== "object") return {};
  const normalized = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.models && typeof entry.models === "object") {
      const migratedModels = {};
      for (const [family, modelEntry] of Object.entries(entry.models)) {
        if (!modelEntry || typeof modelEntry !== "object") continue;
        migratedModels[family] = {
          dataset: modelEntry.dataset ?? entry.dataset,
          family: modelEntry.family ?? family,
          model: modelEntry.model,
          attempts: modelEntry.attempts ?? entry.attempts,
          tasks: modelEntry.tasks ?? entry.tasks,
          reasoning: modelEntry.reasoning ?? entry.reasoning ?? null,
          runUrl: modelEntry.runUrl ?? null,
          harnesses: Array.isArray(modelEntry.harnesses)
            ? modelEntry.harnesses.map(normalizeV1Harness)
            : [],
          taskMatrix: Array.isArray(modelEntry.taskMatrix) ? modelEntry.taskMatrix : [],
          generatedAt: modelEntry.generatedAt,
        };
      }
      normalized[name] = { models: migratedModels };
      continue;
    }
    if (entry.model && Array.isArray(entry.harnesses)) {
      const family = modelFamily(entry.model.id);
      normalized[name] = {
        models: {
          [family]: {
            dataset: entry.dataset,
            family,
            model: entry.model,
            attempts: entry.attempts,
            tasks: entry.tasks,
            reasoning: entry.reasoning ?? null,
            runUrl:
              entry.harnesses.find((h) => h.harness === "eve" || h.harness === "eve-code")
                ?.runUrl ?? null,
            harnesses: entry.harnesses.map(normalizeV1Harness),
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

  let updatedFile = null;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--updated-file") {
      updatedFile = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    positional.push(args[index]);
  }

  if (positional.length < 2) {
    throw new Error(
      "Usage: eve-docs-snapshot.mjs [--updated-file <path>] <report.json> [...report.json] <snapshot.json>",
    );
  }
  const snapshotPath = positional.at(-1);
  const reportPaths = positional.slice(0, -1);
  const beforeRaw = await readFile(snapshotPath, "utf8");
  let snapshot = JSON.parse(beforeRaw);
  const generatedAt = new Date().toISOString();
  const changedFamilies = [];

  for (const reportPath of reportPaths) {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const { skip, section } = snapshotFromReport(report);
    if (skip) {
      console.log(`::notice::eve docs snapshot skipped ${reportPath}: ${skip}.`);
      continue;
    }
    const prevSerialized = JSON.stringify(
      snapshot?.datasets?.[section.dataset.name]?.models?.[section.family] ?? null,
    );
    snapshot = mergeSnapshot(snapshot, section, generatedAt);
    const nextSerialized = JSON.stringify(
      snapshot.datasets[section.dataset.name].models[section.family],
    );
    if (prevSerialized !== nextSerialized) {
      changedFamilies.push(section.family);
    }
  }

  if (updatedFile) {
    await writeFile(
      updatedFile,
      changedFamilies.length > 0 ? `${changedFamilies.join("\n")}\n` : "",
    );
  }

  const nextRaw = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (nextRaw === beforeRaw) return;
  await writeFile(snapshotPath, nextRaw);
  console.log(`Updated ${changedFamilies.join(", ") || "snapshot"} in ${snapshotPath}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
