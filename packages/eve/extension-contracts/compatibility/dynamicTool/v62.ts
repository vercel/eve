import { auto } from "#public/models/index.js";

// Epoch 62 auto routing had no fallback model; the option is additive.
export default auto({
  options: {
    "openai/gpt-5.5": "General-purpose work",
  },
});
