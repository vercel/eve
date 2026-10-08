import { measuredEval } from "./measure";
export default measuredEval(
  "incident-cost",
  "List open status page incidents and cloud infrastructure cost grouped by team.",
  ["sre__status_page_incidents_list", "d0__query_cost"],
);
