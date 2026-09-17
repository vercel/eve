import { autoModel } from "#public/experimental/evaluate/index.js";

export default autoModel({
  model: "typesafe-ai/jev-latest",
  options: {
    "openai/gpt-5.6-sol": "Difficult reasoning and engineering tasks",
    "openai/gpt-5.6-luna": "Routine tasks where fast completion matters",
  },
});
