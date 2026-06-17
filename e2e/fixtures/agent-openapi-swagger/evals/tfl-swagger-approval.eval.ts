import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const SEARCH_TOOL = "connection__search";
const TFL_APPROVAL_JOURNEY_MODES_TOOL = "connection__tfl-approval__Journey_Meta";

export default defineEval({
  description:
    "OpenAPI connection HITL: an approval-gated TfL Swagger operation parks before execution.",

  async test(t) {
    const parked = await t.send(
      [
        "Use the `connection__search` tool with connection `tfl-approval` to find the TfL journey modes operation.",
        "Then call `connection__tfl-approval__Journey_Meta` exactly once with an empty object.",
        "Wait for approval if requested.",
        "After the tool runs, reply with the exact words `bus` and `tube` if both mode names are present in the tool result.",
      ].join("\n"),
    );
    parked.expectOk();

    const [request] = t.expectInputRequests({
      display: "confirmation",
      toolName: TFL_APPROVAL_JOURNEY_MODES_TOOL,
    });
    if (request === undefined) {
      throw new Error("Expected the OpenAPI connection tool to request approval.");
    }

    const optionIds = (request.options ?? []).map((option) => option.id);
    if (!optionIds.includes("approve") || !optionIds.includes("deny")) {
      throw new Error(`Expected approve/deny options, got [${optionIds.join(", ")}].`);
    }
    if (toolResultOutputs(parked.events, TFL_APPROVAL_JOURNEY_MODES_TOOL).length > 0) {
      throw new Error("Approval-gated OpenAPI tool executed before approval.");
    }

    const approved = await t.respondAll("approve");
    approved.expectOk();

    const outputs = toolResultOutputs(t.events, TFL_APPROVAL_JOURNEY_MODES_TOOL);
    if (outputs.length !== 1) {
      throw new Error(
        `Expected "${TFL_APPROVAL_JOURNEY_MODES_TOOL}" to execute exactly once after approval; saw ${outputs.length}.`,
      );
    }
    const [output] = outputs;
    const modes = extractModeNames(output.body);
    if (!modes.has("bus") || !modes.has("tube")) {
      throw new Error(
        `Expected TfL modes to include bus and tube after approval, got ${JSON.stringify([...modes])}`,
      );
    }

    t.didNotFail();
    t.completed();
    t.calledTool(SEARCH_TOOL, { isError: false });
    t.messageIncludes(/\bbus\b/iu);
    t.messageIncludes(/\btube\b/iu);
  },
});

function toolResultOutputs(
  events: readonly HandleMessageStreamEvent[],
  toolName: string,
): Record<string, unknown>[] {
  const outputs: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.type !== "action.result" || event.data.status === "rejected") {
      continue;
    }
    const result = event.data.result;
    if (result.kind !== "tool-result" || result.toolName !== toolName) {
      continue;
    }
    if (typeof result.output !== "object" || result.output === null) {
      throw new Error(
        `Expected object output from "${toolName}"; got ${JSON.stringify(result.output)}.`,
      );
    }
    outputs.push(result.output as Record<string, unknown>);
  }
  return outputs;
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
