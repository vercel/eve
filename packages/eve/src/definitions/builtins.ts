import { sessionOffersTasks } from "#execution/catalog/step-catalog.js";
import { withTaskTools } from "#execution/tasks/model-step.js";
import { FINAL_REPLY_TASK_SYSTEM_BLOCK, TASK_SYSTEM_BLOCK } from "#execution/tasks/render.js";
import { type Definition, once, section, SECTION_ORDER, type ToolEntry } from "./definition.js";

/**
 * What eve adds for its own features, seeing everything the agent declares: the task tools and
 * their note when the session offers tasks.
 */
export const builtins: Definition = {
  contribute: ({ container, step }) => ({
    arrange: (draft) => {
      const offersTasks = once(
        async () =>
          step !== undefined &&
          sessionOffersTasks({
            ctx: container,
            session: step.session,
            tools: [...(await draft.tools()).entries.values()].map(({ definition }) => definition),
          }),
      );
      return {
        system: async () => [
          ...(await draft.system()),
          ...((await offersTasks())
            ? [
                section(
                  "eve.tasks",
                  step!.finalReplyOnly ? FINAL_REPLY_TASK_SYSTEM_BLOCK : TASK_SYSTEM_BLOCK,
                  { order: SECTION_ORDER.tasks, part: "own" },
                ),
              ]
            : []),
        ],
        tools: async () => {
          const tools = await draft.tools();
          if (!(await offersTasks())) return tools;
          const definitions = new Map(
            [...tools.entries].map(([name, entry]) => [name, entry.definition]),
          );
          const added = [...withTaskTools(definitions)].filter(
            ([name]) => !tools.entries.has(name),
          );
          return {
            ...tools,
            entries: new Map([
              ...tools.entries,
              ...added.map(([name, definition]): [string, ToolEntry] => [name, { definition }]),
            ]),
          };
        },
      };
    },
  }),
  id: "eve.builtins",
  label: "eve's builtins",
};
