import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

import { UPGRADE_LEGACY_CONFIG } from "./lib/upgrade-marker.ts";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = [...request.userMessages].reverse().find((entry) => entry.trim() !== "") ?? "";
  const upgrade = /^UPGRADE-(read|gate|task)-([a-z0-9]+)$/u.exec(message);
  if (upgrade === null) return message;
  const name = `upgrade_${upgrade[1]}`;
  const key = upgrade[2]!;
  const id = `${name}-${key}`;
  const result = request.toolResults.find((entry) => entry.id === id);
  return result === undefined
    ? { toolCalls: [{ id, input: { key }, name }] }
    : `UPGRADE-RESULT ${typeof result.output === "string" ? result.output : JSON.stringify(result.output)}`;
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  // The published consumer requires an opt-in removed from the current authoring API.
  ...UPGRADE_LEGACY_CONFIG,
  limits: { sessionTimeoutMs: false },
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});
