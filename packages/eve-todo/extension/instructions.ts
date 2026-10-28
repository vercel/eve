import { defineDynamic, defineInstructions } from "eve/instructions";

import { todos } from "./lib/state.ts";
import { render } from "./lib/todos.ts";

export default defineDynamic(() => {
  const content = render(todos.get());
  return content === null ? null : defineInstructions({ content });
});
