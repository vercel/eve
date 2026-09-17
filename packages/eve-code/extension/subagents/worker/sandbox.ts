import { defineSandbox } from "eve/sandbox";

export default defineSandbox(({ parent }) => {
  if (parent === null) throw new Error("worker must run as a child");
  return parent.sandbox;
});
