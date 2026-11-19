import { defineDynamic } from "eve/tools";

import extension from "../extension.ts";
import { defineBoardFailTaskTool, holdsTask } from "../lib/tools.ts";

/** Gives up on the task the session claimed, with why. Offered only while the session holds a task. */
export default defineDynamic((ctx) =>
  holdsTask(ctx) ? defineBoardFailTaskTool(() => extension.config) : null,
);
