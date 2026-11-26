import { withTaskTools } from "#execution/tasks/model-step.js";
import { FINAL_REPLY_TASK_SYSTEM_BLOCK, TASK_SYSTEM_BLOCK } from "#execution/tasks/render.js";
import {
  type Definition,
  once,
  section,
  SECTION_ORDER,
  type StepInfo,
  type ToolEntry,
} from "./definition.js";

export const builtins: Definition = {
  contribute: (ctx) => ({
    arrange: (draft) => {
      const { step } = ctx;
      const hasTasks = once(async () => {
        if (step === undefined) return false;
        const active = hasSessionTasks(step);
        const kept = await ctx.keep((_evaluation, previous) =>
          previous === true || active ? { value: true } : null,
        );
        return active || kept?.value === true;
      });
      return {
        system: async () => [
          ...(await draft.system()),
          ...((await hasTasks())
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
          if (!(await hasTasks())) return tools;
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

function hasSessionTasks(step: StepInfo): boolean {
  const tasks = step.view?.().projection.view.tasks ?? {};
  return Object.keys(tasks).length > 0;
}
