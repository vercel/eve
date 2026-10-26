// World probe for one benchmark leg: writes the workflow event log of every
// session in the leg's eval artifacts to <out-dir>/<sessionId>.json (a
// session id is its workflow run id). The trusted publish job derives the
// `durability.*` metrics from these files.
//
// Payloads are not copied: each event keeps its type, correlation id, time,
// and step name, and the stored size of each payload field. That is all the
// durable-work counters need, and it keeps transcripts out of the probe.
//
// The world is the one the leg's server ran on: the package named by
// EVE_E2E_WORKFLOW_WORLD (configured from its own environment, such as
// WORKFLOW_POSTGRES_URL), or eve's local world. A local world's data is under
// `.eve/eval-servers/<run>/.workflow-data` after `eve eval --keep-state`, or
// `.eve/.workflow-data` after `eve start`. The world is opened for reads only
// and never started, so nothing is redelivered.
//
// Usage: node scripts/eval-benchmark/export-world.mjs <fixture-dir> <out-dir>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { listEvalArtifacts } from "../eval-metrics/standard.mjs";

const PAGE_LIMIT = 1000;
const MAX_EVENTS_PER_RUN = 50_000;

/** Session ids of every captured session in a fixture's single eval run. */
export function sessionIdsOf(fixtureDir) {
  const evalsDir = join(fixtureDir, ".eve", "evals");
  const runs = existsSync(evalsDir) ? readdirSync(evalsDir) : [];
  if (runs.length !== 1)
    throw new Error(`Expected one .eve/evals run in ${fixtureDir}, found ${runs.length}.`);
  const ids = new Set();
  for (const path of listEvalArtifacts(join(evalsDir, runs[0]))) {
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    for (const session of artifact?.result?.sessions ?? [])
      if (typeof session?.sessionId === "string") ids.add(session.sessionId);
  }
  return [...ids].sort();
}

/** The local world's data directory a leg's server wrote. */
export function localDataDir(fixtureDir) {
  const servers = join(fixtureDir, ".eve", "eval-servers");
  const candidates = [
    ...(existsSync(servers)
      ? readdirSync(servers).map((name) => join(servers, name, ".workflow-data"))
      : []),
    join(fixtureDir, ".eve", ".workflow-data"),
  ].filter((dir) => existsSync(dir));
  if (candidates.length !== 1)
    throw new Error(
      `Expected one local Workflow data directory in ${fixtureDir}, found ${candidates.length}; run \`eve eval --keep-state\` or \`eve start\`.`,
    );
  return candidates[0];
}

async function openWorld(fixtureDir) {
  const require = createRequire(join(resolve(fixtureDir), "package.json"));
  const worldPackage = process.env.EVE_E2E_WORKFLOW_WORLD;
  if (worldPackage) {
    const { createWorld } = await import(pathToFileURL(require.resolve(worldPackage)).href);
    return { name: worldPackage, world: createWorld() };
  }
  // eve's vendored world-local is the one that wrote the data.
  const eveDir = dirname(require.resolve("eve/package.json"));
  const entry = join(eveDir, "dist", "src", "compiled", "@workflow", "world-local", "index.js");
  const { createWorld } = await import(pathToFileURL(entry).href);
  return { name: "local", world: createWorld({ dataDir: localDataDir(fixtureDir) }) };
}

async function listRunEvents(world, runId) {
  const events = [];
  let cursor;
  do {
    const page = await world.events.list({
      runId,
      resolveData: "all",
      pagination: { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
    });
    events.push(...page.data);
    if (events.length > MAX_EVENTS_PER_RUN)
      throw new Error(`Run ${runId} has more than ${MAX_EVENTS_PER_RUN} workflow events.`);
    cursor = page.hasMore && page.cursor ? page.cursor : undefined;
  } while (cursor !== undefined);
  return events;
}

const PAYLOAD_FIELDS = ["input", "result", "output", "error"];

/** One workflow event without its payloads: identity, time, and payload sizes. */
export function summarizeWorkflowEvent(event) {
  const data = event?.eventData ?? {};
  const payloadBytes = {};
  for (const field of PAYLOAD_FIELDS) {
    const bytes = storedBytes(data[field]);
    if (bytes !== undefined) payloadBytes[field] = bytes;
  }
  const summary = {
    eventType: event?.eventType,
    correlationId: event?.correlationId ?? null,
    createdAt: event?.createdAt ?? null,
    payloadBytes,
  };
  if (typeof data.stepName === "string") summary.stepName = data.stepName;
  return summary;
}

/** Stored size of one payload: binary as is, anything else as JSON text. */
function storedBytes(value) {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value);
  return Buffer.byteLength(JSON.stringify(value));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [fixtureDir, outDir] = process.argv.slice(2);
  if (outDir === undefined) {
    console.error("Usage: node scripts/eval-benchmark/export-world.mjs <fixture-dir> <out-dir>");
    process.exit(1);
  }
  const sessionIds = sessionIdsOf(fixtureDir);
  const { name, world } = await openWorld(fixtureDir);
  mkdirSync(outDir, { recursive: true });
  for (const runId of sessionIds) {
    const events = await listRunEvents(world, runId);
    writeFileSync(
      join(outDir, `${runId}.json`),
      JSON.stringify({ runId, world: name, events: events.map(summarizeWorkflowEvent) }),
    );
  }
  console.error(`Exported ${sessionIds.length} workflow runs from the ${name} world to ${outDir}.`);
  // A world may hold pools or timers open; this process only reads.
  process.exit(0);
}
