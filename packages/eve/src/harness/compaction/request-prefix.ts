import type { LanguageModel } from "ai";

import { stepCatalog, stepSystem } from "#definitions/step.js";
import type { RequestPrefix } from "#harness/compaction/authored.js";
import { modelInstructions } from "#harness/model-call/request.js";
import { prepareModelTools } from "#harness/model-call/tools.js";
import { resolveModelProfile } from "#harness/model-profile.js";
import type { Step } from "#harness/step/context.js";

export async function requestPrefix(step: Step, model: LanguageModel): Promise<RequestPrefix> {
  const profile = resolveModelProfile(model);
  return {
    instructions: modelInstructions({ instructions: await stepSystem(step), profile }),
    tools: await prepareModelTools(step, { catalog: await stepCatalog(step), profile }),
  };
}
