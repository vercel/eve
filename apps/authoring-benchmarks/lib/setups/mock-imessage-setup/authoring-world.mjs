import { appendFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.EVE_AUTHORING_EVAL_DIRECTORY ?? "__authoring_eval__";

export function authoringStatePath(name) {
  return join(ROOT, `${name}.json`);
}

export function recordAuthoringEvent(type, data) {
  appendFileSync(
    join(ROOT, "world-events.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), type, data })}\n`,
  );
}
