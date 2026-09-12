import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [fixtureDirectory, outputDirectory] = process.argv.slice(2);
if (!fixtureDirectory || !outputDirectory) {
  throw new Error("Usage: capture-workflow-events.mjs <fixture-directory> <output-directory>");
}

const directory = join(fixtureDirectory, ".eve", ".workflow-data", "events");
const files = await readdir(directory).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
const events = [];
for (const file of files.filter((file) => file.endsWith(".json"))) {
  const event = JSON.parse(await readFile(join(directory, file), "utf8"));
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
events.sort((a, b) => String(a.eventId).localeCompare(String(b.eventId)));
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "workflow-events.json"), JSON.stringify(events, null, 2));
