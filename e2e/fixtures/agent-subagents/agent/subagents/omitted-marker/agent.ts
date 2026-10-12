import { defineDynamic, once } from "eve";

export default defineDynamic({
  select: once,
  render: () => null,
});
