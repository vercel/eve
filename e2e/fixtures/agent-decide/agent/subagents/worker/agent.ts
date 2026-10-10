import { defineDynamic } from "eve";

import { fixtureModel, routing } from "../../testing";

export default defineDynamic({
  description: "Complete one assigned investigation.",
  ...fixtureModel(() => `child-result:${routing.get().model}:${routing.get().requests}`),
});
