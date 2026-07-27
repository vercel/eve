import { defineDynamic } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "turn.started"() {
      return null;
    },
  },
});
