import { defineState } from "eve/context";

export const classificationProbe = defineState("jev-instrumentation.classification", () => ({
  observed: "unselected",
  requests: 0,
  result: "unselected",
}));
