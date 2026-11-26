import { sessionOffersTasks } from "#execution/catalog/step-catalog.js";
import { withTaskTools } from "#execution/tasks/model-step.js";
import { FINAL_REPLY_TASK_SYSTEM_BLOCK, TASK_SYSTEM_BLOCK } from "#execution/tasks/render.js";
import { type Definition, once, type StepInfo, type ToolEntry } from "./definition.js";

export const builtins: Definition = {
  contribute: (ctx) => ({
    arrange: (draft) => {
      const { container, step } = ctx;
      const hasTasks = once(async () => {
        if (step === undefined) return false;
        const active = hasSessionTasks(step);
        const kept = await ctx.keep((_evaluation, previous) =>
          previous === true || active ? { value: true } : null,
        );
        return active || kept?.value === true;
      });
      const offersTaskTools = once(
        async () =>
          step !== undefined &&
          ((await hasTasks()) ||
            sessionOffersTasks({
              ctx: container,
              session: step.session,
              tools: [...(await draft.tools()).entries.values()].map(
                ({ definition }) => definition,
              ),
            })),
      );
      return {
        announcements: async () => {
          const existing = await draft.announcements();
          if (step === undefined || !(await hasTasks())) return existing;
          const variant = step.finalReplyOnly ? "final-reply" : "root";
          const block = step.finalReplyOnly ? FINAL_REPLY_TASK_SYSTEM_BLOCK : TASK_SYSTEM_BLOCK;
          return {
            ...existing,
            "eve.tasks": {
              initial: "",
              kind: "context.state",
              render: () => block,
              value: variant,
            },
          };
        },
        tools: async () => {
          const tools = await draft.tools();
          if (!(await offersTaskTools())) return tools;
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
