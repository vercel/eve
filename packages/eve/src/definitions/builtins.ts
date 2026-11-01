import { catalogAnnouncements } from "#execution/catalog/listing.js";
import { sessionOffersTasks } from "#execution/catalog/step-catalog.js";
import { dynamicSkillAnnouncements } from "#execution/skills/instructions.js";
import { withTaskTools } from "#execution/tasks/model-step.js";
import { FINAL_REPLY_TASK_SYSTEM_BLOCK, TASK_SYSTEM_BLOCK } from "#execution/tasks/render.js";
import type { Announcement } from "#harness/announcements.js";
import { PARALLEL_ACTION_INSTRUCTION } from "#runtime/prompt/compose.js";
import {
  type CallInput,
  type Definition,
  once,
  section,
  SECTION_ORDER,
  type ToolEntry,
} from "./definition.js";
import { announce } from "./messages.js";
import { dynamicSkillManifest } from "./skills.js";

/**
 * What eve adds for its own features, seeing everything the agent declares: the note on parallel
 * calls when the agent has tools of its own, the task tools and their note when the session
 * offers tasks, the note on calls awaiting approval, and announcements of what the catalog reaches.
 */
export const builtins: Definition = {
  contribute: ({ call, container, step }) => ({
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
        record: async () => {
          const record = await draft.record();
          return record === undefined || call === undefined
            ? record
            : announce(record, call.currentInput, announcements(call, container));
        },
        system: async () => {
          const ownTools = (await draft.tools()).entries.size > 0;
          return [
            ...(await draft.system()),
            ...(ownTools
              ? [section("eve.tools", PARALLEL_ACTION_INSTRUCTION, { order: SECTION_ORDER.tools })]
              : []),
            ...((await offersTasks())
              ? [
                  section(
                    "eve.tasks",
                    step!.finalReplyOnly ? FINAL_REPLY_TASK_SYSTEM_BLOCK : TASK_SYSTEM_BLOCK,
                    { order: SECTION_ORDER.tasks, part: "own" },
                  ),
                ]
              : []),
          ];
        },
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

/** What eve announces about the step's catalog: what its catalog tools reach, and dynamic skills. */
function announcements(
  { catalog, historyState }: CallInput,
  container: Parameters<typeof dynamicSkillManifest>[0],
): Readonly<Record<string, Announcement>> {
  const announced = historyState.announcements;
  return {
    ...catalogAnnouncements(catalog, announced),
    ...dynamicSkillAnnouncements(dynamicSkillManifest(container), announced),
  };
}
