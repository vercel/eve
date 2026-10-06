import type { Experimental_EvaluationModel } from "ai";

import { auto } from "#public/models/index.js";

declare const model: Experimental_EvaluationModel;

// Epoch 71 typed `auto({ model })` with the AI SDK's pre-rename evaluation model alias, which
// remains assignable to the decision model that `auto` accepts today.
export default auto({
  model,
  options: { "openai/gpt-6-luna": "Routine tasks where fast completion matters" },
});
