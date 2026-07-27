import { defineDynamic } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "turn.started"() {
      return null;
    },
  },
});
