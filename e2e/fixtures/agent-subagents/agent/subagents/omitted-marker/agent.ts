import { defineDynamic } from "eve";

export default defineDynamic({
  events: {
    "session.started": () => null,
  },
});
