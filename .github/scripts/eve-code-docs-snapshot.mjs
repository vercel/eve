// Turns an eve-bench report.json into the public eve-code results snapshot the docs render.
// The snapshot keeps only aggregate scores and public run links: the result store is private,
// so blob URLs and per-trial data never reach the docs.
import { readFile, writeFile } from "node:fs/promises";

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Returns the dataset section for a report, or a reason why it must not be published. */
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
  const results = new Map(comparison.results.map((result) => [result.harness, result]));
  if (!results.has("eve-code")) return { skip: "report has no eve-code result" };

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

  return {
    section: {
      dataset: { name: manifest.dataset.name, version: manifest.dataset.version },
      model: manifest.modelVersion ?? { id: manifest.model },
      attempts: manifest.attempts,
      tasks: manifest.tasks.length,
      harnesses: comparison.summary.scores.map((score) => {
        const result = results.get(score.contender);
        if (!result) throw new Error(`No result for contender ${score.contender}.`);
        return {
          harness: score.contender,
          version: harnessVersion(score.contender, result.provenance),
          resolved: score.resolved,
          attempts: score.attempts,
          resolveRate: score.resolveRate,
          costUsd: score.costUsd ?? null,
          costPerResolvedUsd: score.costPerResolvedUsd ?? null,
          inputTokens: score.inputTokens,
          outputTokens: score.outputTokens,
          cachedShare: score.cachedShare ?? null,
          latencyP50Ms: score.latencyP50Ms,
          latencyP90Ms: score.latencyP90Ms,
          source: result.provenance.source?.revision ?? null,
          runUrl: result.provenance.run?.url ?? null,
          measuredAt: publishedAt.get(score.contender) ?? finishedAt(result),
        };
      }),
    },
  };
}

/** A released harness reports its package version; eve-code is identified by its source commit. */
function harnessVersion(harness, provenance) {
  const settings = provenance.harness ?? {};
  const version = settings.version ?? settings[`${harness}Version`];
  if (typeof version === "string") return version;
  const sha = settings.source?.gitSha ?? provenance.source?.revision;
  return typeof sha === "string" ? sha.slice(0, 7) : null;
}

/** Replaces one dataset's section in an existing snapshot. */
export function mergeSnapshot(existing, section, generatedAt) {
  const datasets = { ...existing?.datasets, [section.dataset.name]: { ...section, generatedAt } };
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, datasets };
}

/** GraphQL body for a GitHub-signed commit of the snapshot onto `expectedHeadOid`. */
export function commitPayload({ repository, branch, expectedHeadOid, path, contents, runUrl }) {
  return {
    query:
      "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { url } } }",
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: branch },
        expectedHeadOid,
        message: {
          headline: "docs: refresh eve-code benchmark results",
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
      branch: "main",
      expectedHeadOid: env.HEAD_OID,
      path,
      contents: await readFile(path),
      runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    });
    process.stdout.write(JSON.stringify(payload));
    return;
  }
  const [reportPath, snapshotPath] = args;
  if (!reportPath || !snapshotPath) {
    throw new Error("Usage: eve-code-docs-snapshot.mjs <report.json> <snapshot.json>");
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const { skip, section } = snapshotFromReport(report);
  if (skip) {
    console.log(`::notice::eve-code docs snapshot not updated: ${skip}.`);
    return;
  }
  const existing = JSON.parse(await readFile(snapshotPath, "utf8"));
  const next = mergeSnapshot(existing, section, new Date().toISOString());
  await writeFile(snapshotPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Updated ${section.dataset.name} in ${snapshotPath}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
