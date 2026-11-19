import { defineDynamic } from "eve/tools";

import extension from "../extension.ts";
import { defineBoardCompleteTaskTool, holdsTask } from "../lib/tools.ts";

/** Completes the task the session claimed, with the result. Offered only while the session holds a task. */
export default defineDynamic((ctx) =>
  holdsTask(ctx) ? defineBoardCompleteTaskTool(() => extension.config) : null,
);
