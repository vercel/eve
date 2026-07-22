import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(),
  modelContextWindowTokens: 1_000_000,
});
