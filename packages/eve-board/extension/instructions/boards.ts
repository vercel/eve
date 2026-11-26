import { defineDynamic, defineInstructions } from "eve/instructions";

import extension from "../extension.ts";
import { formatConfiguredBoards } from "../lib/boards.ts";

export default defineDynamic(() => {
  const content = formatConfiguredBoards(extension.config);
  return content === null ? null : defineInstructions({ content });
});
