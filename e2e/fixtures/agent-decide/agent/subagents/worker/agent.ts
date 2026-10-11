import { defineAgent } from "eve";

import { fixtureModel, routing } from "../../testing";

export default defineAgent({
  description: "Complete one assigned investigation.",
  model: fixtureModel(() => `child-result:${routing.get().model}:${routing.get().requests}`),
});
