import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import interactiveInstructions from "./content/role/interactive.md?raw";
import scheduledReportInstructions from "./content/role/scheduled-report.md?raw";
import scheduledWorkerInstructions from "./content/role/scheduled-worker.md?raw";

export default defineDynamic((context) =>
  resolveModeInstructions(context, {
    interactive: interactiveInstructions,
    "scheduled-report": scheduledReportInstructions,
    "scheduled-worker": scheduledWorkerInstructions,
  })
);
