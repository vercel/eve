import { defineDynamic } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "turn.started"() {
      return null;
    },
  },
});
