import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel("Hello from the Datadog eval fixture."),
  modelContextWindowTokens: 1_000_000,
});
