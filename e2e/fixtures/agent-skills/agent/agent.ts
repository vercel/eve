import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import { PREFIX_REQUEST, prefixModel } from "./lib/prompt-prefix";
import type { MockModelRequest } from "eve/evals";

const DYNAMIC_INSTRUCTIONS_TOKEN = "dynamic-instructions-ok-M3K8";

function respond(request: MockModelRequest): string {
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
