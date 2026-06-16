import type { EveEvalTurn } from "eve/evals";
import { defineEval } from "eve/evals";

const SEARCH_TOOL = "connection__search";
const TFL_JOURNEY_MODES_TOOL = "connection__tfl__Journey_Meta";

export default defineEval({
  description:
    "OpenAPI connection smoke: TfL's Swagger 2.0 document exposes and calls Journey_Meta.",

  async test(t) {
    const turn = await t.send(
      [
        "Use the `connection__search` tool to find the TfL journey modes operation in the `tfl` connection.",
        "Then call `connection__tfl__Journey_Meta` exactly once with an empty object.",
        "Reply with the exact words `bus` and `tube` if both mode names are present in the tool result.",
      ].join("\n"),
    );
    turn.expectOk();

    const output = requireToolOutput(turn, TFL_JOURNEY_MODES_TOOL);
    const modes = extractModeNames(output.body);
    if (!modes.has("bus") || !modes.has("tube")) {
      throw new Error(
        `Expected TfL modes to include bus and tube, got ${JSON.stringify([...modes])}`,
      );
    }

    t.didNotFail();
    t.completed();
    t.toolOrder([SEARCH_TOOL, TFL_JOURNEY_MODES_TOOL]);
    t.calledTool(SEARCH_TOOL, { isError: false });
    t.calledTool(TFL_JOURNEY_MODES_TOOL, { isError: false, times: 1 });
    t.messageIncludes(/\bbus\b/iu);
    t.messageIncludes(/\btube\b/iu);
  },
});

function requireToolOutput(turn: EveEvalTurn, toolName: string): Record<string, unknown> {
  const call = turn.toolCalls.find((candidate) => candidate.name === toolName);
  if (call === undefined) {
    const seen = turn.toolCalls.map((candidate) => candidate.name).join(", ");
    throw new Error(`Expected a "${toolName}" call in this turn; saw [${seen}].`);
  }
  if (typeof call.output !== "object" || call.output === null) {
    throw new Error(
      `Expected object output from "${toolName}"; got ${JSON.stringify(call.output)}.`,
    );
  }
  return call.output as Record<string, unknown>;
}

function extractModeNames(body: unknown): Set<string> {
  const modes = new Set<string>();
  if (!Array.isArray(body)) {
    return modes;
  }
  for (const item of body) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const modeName = (item as { modeName?: unknown }).modeName;
    if (typeof modeName === "string") {
      modes.add(modeName);
    }
  }
  return modes;
}
