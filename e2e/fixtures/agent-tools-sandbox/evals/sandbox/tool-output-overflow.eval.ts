import { defineEval } from "eve/evals";

const OVERFLOW_PROBE_PAYLOAD_BYTES = 128 * 1024;
const OVERFLOW_PROBE_TOKEN = "tool-output-overflow-ok-R4V";

export default defineEval({
  description:
    "Tool output overflow: oversized model history becomes a readable sandbox reference while action.result stays complete.",
  async test(t) {
    await t.send(
      [
        "Run the `overflow_probe` tool exactly once.",
        `Read the generated eve tool-output file by running the bash command \`grep -m 1 -o '${OVERFLOW_PROBE_TOKEN}' <reference path>\` with the actual reference path.`,
        `Reply with exactly ${OVERFLOW_PROBE_TOKEN}.`,
      ].join("\n"),
    );

    t.succeeded();
    t.calledTool("overflow_probe", {
      count: 1,
      output: hasCompleteProbeOutput,
    });
    t.calledTool("bash", {
      count: 1,
      output: new RegExp(OVERFLOW_PROBE_TOKEN),
    });
    t.messageIncludes(OVERFLOW_PROBE_TOKEN);
  },
});

function hasCompleteProbeOutput(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const output = value as { marker?: unknown; payload?: unknown };
  return (
    output.marker === OVERFLOW_PROBE_TOKEN &&
    typeof output.payload === "string" &&
    output.payload.length === OVERFLOW_PROBE_PAYLOAD_BYTES
  );
}
