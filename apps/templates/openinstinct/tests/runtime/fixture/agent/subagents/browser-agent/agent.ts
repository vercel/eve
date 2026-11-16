import { defineAgent } from "eve";
import { fixtureModel } from "../../lib/model";

export default defineAgent({
  description: "Deterministic lifecycle fixture",
  tool: false,
  defaultTools: false,
  model: fixtureModel(true),
});
