import { defineDynamic } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return null;
    },
  },
});
