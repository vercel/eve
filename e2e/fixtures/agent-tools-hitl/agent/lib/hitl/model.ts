import { mockModel } from "eve/evals";

import { respond } from "./respond.ts";

type Prompt = Parameters<Exclude<ReturnType<typeof mockModel>, string>["doGenerate"]>[0]["prompt"];

/**
 * The hitl suite's scripted model. eve runs approved calls itself, so
 * no prompt may carry an AI SDK approval part; one fails the turn.
 */
export function humanInputModel() {
  const model = mockModel({ modelId: "hitl", respond });
  if (typeof model === "string" || model.specificationVersion !== "v4") {
    throw new Error("This fixture expects mockModel's v4 provider boundary.");
  }
  const generate = model.doGenerate.bind(model);
  const stream = model.doStream.bind(model);
  model.doGenerate = async (options) => {
    rejectApprovalParts(options.prompt);
    return generate(options);
  };
  model.doStream = async (options) => {
    rejectApprovalParts(options.prompt);
    return stream(options);
  };
  return model;
}

function rejectApprovalParts(prompt: Prompt) {
  for (const message of prompt) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type.includes("approval")) {
        throw new Error(`Model history carries an AI SDK approval part: ${part.type}.`);
      }
    }
  }
}
