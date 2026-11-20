import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [fixtureDirectory, outputDirectory] = process.argv.slice(2);
if (!fixtureDirectory || !outputDirectory) {
  throw new Error("Usage: capture-workflow-events.mjs <fixture-directory> <output-directory>");
}

const PAGE_LIMIT = 1000;

const eveDirectory = join(fixtureDirectory, ".eve");
const evalServers = join(eveDirectory, "eval-servers");
const dataDirectories = [
  join(eveDirectory, ".workflow-data"),
  ...(existsSync(evalServers)
    ? readdirSync(evalServers).map((name) => join(evalServers, name, ".workflow-data"))
    : []),
].filter((dataDir) => existsSync(join(dataDir, "world.db")));

await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, "workflow-events.json");
if (dataDirectories.length === 0) {
  await writeFile(outputPath, "[]");
  process.exit(0);
}

const require = createRequire(join(resolve(fixtureDirectory), "package.json"));
const eveRoot = dirname(require.resolve("eve/package.json"));
const { createWorld } = await import(
  pathToFileURL(join(eveRoot, "dist", "src", "compiled", "@workflow", "world-local", "index.js"))
    .href
);

async function* listAll(listPage) {
  let cursor;
  do {
    const page = await listPage({ limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
    yield* page.data;
    cursor = page.hasMore && page.cursor ? page.cursor : undefined;
  } while (cursor !== undefined);
}

const events = [];
for (const dataDir of dataDirectories) {
  const world = createWorld({ dataDir, queueAuthKey: "read" });
  try {
    for await (const run of listAll((pagination) =>
      world.runs.list({ resolveData: "none", pagination }),
    )) {
      for await (const event of listAll((pagination) =>
        world.events.list({ runId: run.runId, resolveData: "all", pagination }),
      )) {
        // Never retain serialized inputs, hook payloads, credentials, or model content.
        events.push({
          runId: event.runId,
          eventId: event.eventId,
          eventType: event.eventType,
          correlationId: event.correlationId,
          createdAt: event.createdAt,
          stepName: event.eventData?.stepName,
          ownerMessageId: event.eventData?.ownerMessageId,
        });
      }
    }
  } finally {
    await world.close();
  }
}
events.sort((a, b) => String(a.eventId).localeCompare(String(b.eventId)));
await writeFile(outputPath, JSON.stringify(events, null, 2));
