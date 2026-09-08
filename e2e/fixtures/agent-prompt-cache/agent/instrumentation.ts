import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineInstrumentation } from "eve/instrumentation";
import { promptRecordsPath } from "../prompt-records";

export default defineInstrumentation({
  events: {
    "step.started"({ modelInput, session, step, turn }) {
      if (session.parent !== undefined) return;
      const path = promptRecordsPath(session.id);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(
        path,
        JSON.stringify({
          turnId: turn.id,
          stepIndex: step.index,
          instructions: fingerprint(modelInput.instructions ?? null),
          messages: modelInput.messages.map(fingerprint),
        }) + "\n",
      );
    },
  },
});

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
