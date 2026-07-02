import { defineEval } from "eve/evals";

const SEARCH_TOOL = "connection_search";
const TFL_JOURNEY_MODES_TOOL = "tfl__Journey_Meta";

export default defineEval({
  description:
    "OpenAPI connection smoke: TfL's Swagger 2.0 document exposes and calls Journey_Meta.",

  async test(t) {
    const turn = await t.send(
      [
        "Use the `connection_search` tool to find the TfL journey modes operation in the `tfl` connection.",
        "Then call `tfl__Journey_Meta` exactly once with an empty object.",
        "Reply with the exact words `bus` and `tube` if both mode names are present in the tool result.",
      ].join("\n"),
    );

    turn.calledTool(TFL_JOURNEY_MODES_TOOL, {
      output: hasBusAndTube,
      count: 1,
    });

    t.succeeded();
    t.toolOrder([SEARCH_TOOL, TFL_JOURNEY_MODES_TOOL]);
    t.calledTool(SEARCH_TOOL);
    t.calledTool(TFL_JOURNEY_MODES_TOOL, {
      output: hasBusAndTube,
      count: 1,
    });
    t.messageIncludes(/\bbus\b/iu);
    t.messageIncludes(/\btube\b/iu);
  },
});

function hasBusAndTube(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const modes = extractModeNames((value as { body?: unknown }).body);
  return modes.has("bus") && modes.has("tube");
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
