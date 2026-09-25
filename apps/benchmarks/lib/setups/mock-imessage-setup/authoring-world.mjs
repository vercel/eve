import { appendFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.EVE_AUTHORING_EVAL_DIRECTORY;
if (ROOT === undefined) throw new Error("EVE_AUTHORING_EVAL_DIRECTORY is required.");

export function authoringStatePath(name) {
  return join(ROOT, `${name}.json`);
}

export function recordAuthoringEvent(type, data) {
  appendFileSync(
    join(ROOT, "world-events.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), type, data })}\n`,
  );
}
