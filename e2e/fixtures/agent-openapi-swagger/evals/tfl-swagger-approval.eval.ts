import { defineEval } from "eve/evals";

const SEARCH_TOOL = "connection_search";
const TFL_APPROVAL_JOURNEY_MODES_TOOL = "tfl-approval__Journey_Meta";

export default defineEval({
  description:
    "OpenAPI connection HITL: an approval-gated TfL Swagger operation parks before execution.",

  async test(t) {
    const parked = await t.send(
      [
        "Use the `connection_search` tool with connection `tfl-approval` to find the TfL journey modes operation.",
        "Then call `tfl-approval__Journey_Meta` exactly once with an empty object.",
        "Wait for approval if requested.",
        "After the tool runs, reply with the exact words `bus` and `tube` if both mode names are present in the tool result.",
      ].join("\n"),
    );
    parked.expectOk();

    t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: TFL_APPROVAL_JOURNEY_MODES_TOOL,
    });
    parked.calledTool(TFL_APPROVAL_JOURNEY_MODES_TOOL, { status: "pending", count: 1 });

    const approved = await t.respondAll("approve");
    approved.expectOk();

    approved.event("action.result", {
      data: {
        result: { kind: "tool-result", toolName: TFL_APPROVAL_JOURNEY_MODES_TOOL },
        status: "completed",
      },
      count: 1,
    });

    t.succeeded();
    t.calledTool(SEARCH_TOOL);
    t.calledTool(TFL_APPROVAL_JOURNEY_MODES_TOOL, {
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
