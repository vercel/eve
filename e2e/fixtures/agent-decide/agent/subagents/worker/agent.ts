import { defineAgent } from "eve";

import { fixtureModel } from "../../testing";

export default defineAgent({
  description: "Complete one assigned investigation.",
  model: fixtureModel((_request, routing) => `child-result:${routing.model}:${routing.decisions}`),
});
