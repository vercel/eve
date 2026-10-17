import { defineDynamic } from "eve/tools";

export default defineDynamic({
  events: {
    beforeSession: async () => {
      return null;
    },
  },
});
