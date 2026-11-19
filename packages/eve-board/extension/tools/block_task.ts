import { defineDynamic } from "eve/tools";

import extension from "../extension.ts";
import { defineBoardBlockTaskTool, holdsTask } from "../lib/tools.ts";

/** Holds the task the session claimed for a person, with the one question they must answer. Offered only while the session holds a task. */
export default defineDynamic((ctx) =>
  holdsTask(ctx) ? defineBoardBlockTaskTool(() => extension.config) : null,
);
