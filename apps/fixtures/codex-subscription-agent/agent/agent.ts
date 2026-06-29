import { defineAgent } from "eve";
import { experimental_codex } from "eve/codex";

export default defineAgent({
  model: experimental_codex({ model: "gpt-5.2-codex" }),
  modelContextWindowTokens: 400_000,
});
