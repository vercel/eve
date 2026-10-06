import { e2eAgentConfig } from "@eve-e2e/config";
import { outputOf, playScript } from "@eve-e2e/config/mock-script";
import { defineAgent, defineDynamic } from "eve";
import { PREFIX_REQUEST, prefixModel } from "./lib/prompt-prefix";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const DYNAMIC_INSTRUCTIONS_TOKEN = "dynamic-instructions-ok-M3K8";
const SKILL_LOAD_DIRECTIVE = "SKILL-LOAD";

/** Loads each named skill with execute({ skill }), then replies with each skill's last line. */
function loadSkills(
  request: MockModelRequest,
  names: readonly string[],
): MockModelResponse | string {
  return playScript(
    request,
    names.map((skill) => ({ id: `load-${skill}`, input: () => ({ skill }), name: "execute" })),
    (finished) =>
      names.map((skill) => outputOf(finished, `load-${skill}`).trim().split("\n").at(-1)).join(" "),
  );
}

function respond(request: MockModelRequest): MockModelResponse | string {
  const directive = request.userMessages.find((message) =>
    message.startsWith(SKILL_LOAD_DIRECTIVE),
  );
  if (directive !== undefined) {
    return loadSkills(request, directive.slice(SKILL_LOAD_DIRECTIVE.length).trim().split(/\s+/u));
  }
  const hasDynamicUserInstruction = request.userMessages.some((message) =>
    message.includes(DYNAMIC_INSTRUCTIONS_TOKEN),
  );
  return hasDynamicUserInstruction ? DYNAMIC_INSTRUCTIONS_TOKEN : "missing dynamic instructions";
}

const { model, modelContextWindowTokens, ...config } = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...config,
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) =>
        ctx.messages.some(
          (message) => message.role === "user" && message.content === PREFIX_REQUEST,
        )
          ? { model: prefixModel, modelContextWindowTokens: 1_000_000 }
          : { model, modelContextWindowTokens },
    },
  }),
  reasoning: "high",
});
