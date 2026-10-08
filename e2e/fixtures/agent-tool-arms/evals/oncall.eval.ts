import { measuredEval } from "./measure";
export default measuredEval("oncall", "Who is on call for the platform team this week?", [
  "sre__oncall_schedule_get",
]);
