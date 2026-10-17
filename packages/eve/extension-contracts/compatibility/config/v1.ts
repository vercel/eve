import { defineAgent } from "../../../src/public/index.js";

// The added named config types preserve the existing inline authoring contract.
export default defineAgent({
  model: "openai/gpt-5.4",
  build: { externalDependencies: ["example-adapter"] },
});
