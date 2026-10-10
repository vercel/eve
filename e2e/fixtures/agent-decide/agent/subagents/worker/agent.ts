import { defineDynamic } from "eve";

import { fixtureModel } from "../../testing";

export default defineDynamic({
  description: "Complete one assigned investigation.",
  ...fixtureModel((_request, routing) => `child-result:${routing.model}:${routing.requests}`),
});
