import { defineDynamic, once } from "eve/tools";

export default defineDynamic({
  select: once,
  render: () => {
    return null;
  },
});
