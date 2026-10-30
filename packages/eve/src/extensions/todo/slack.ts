import { defineSlackRenderer, type SlackRenderer } from "#public/channels/slack/renderers.js";

import { latestTodos, planCard } from "./extension/lib/plan.ts";

/** Options for {@link todoSlackRenderer}. */
export interface TodoSlackRendererOptions {
  /**
   * The file name of the extension's mount under `agent/extensions/`, which prefixes its tool.
   * Default `"todo"`, for `agent/extensions/todo.ts` and its `todo__write` tool.
   */
  readonly mount?: string;
}

/**
 * A Slack renderer that shows the checklist from `eve/extensions/todo` on the turn's task card:
 * the steps as plan rows, ahead of eve's rows for the turn's tasks. A turn that doesn't write the
 * list keeps eve's default card.
 */
export function todoSlackRenderer(options: TodoSlackRendererOptions = {}): SlackRenderer {
  const toolName = `${options.mount ?? "todo"}__write`;
  return defineSlackRenderer({
    taskCard(card, next) {
      const rendered = next(card);
      const items = latestTodos(card.calls, toolName);
      if (items === undefined) return rendered;
      // One id for the whole turn keeps the rows a reader expanded across updates.
      return planCard(items, rendered, `eve_todo_${card.turnId}`.slice(0, 255));
    },
  });
}
