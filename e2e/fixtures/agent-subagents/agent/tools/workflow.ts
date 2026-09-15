import { workflow } from "eve/tools/workflow";

export default workflow({
  agents: [
    "conditional-marker",
    "echo-marker",
    "limited-worker",
    "omitted-marker",
    "self-modification",
    "ticket-reproducer",
    "ticket-review",
    "ticket-triage",
  ],
  maxSubagents: 3,
});
