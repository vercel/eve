import { defineState } from "eve/context";

import type { TodoItem } from "./todos.ts";

export const todos = defineState<readonly TodoItem[]>("todos", () => []);
